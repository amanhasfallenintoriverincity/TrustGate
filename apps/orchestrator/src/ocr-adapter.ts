import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { devNull } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { execa } from "execa";

const require = createRequire(import.meta.url);
// OCR invokes repository-aware Git, so the repository's config and attributes
// are executable control input. This Linux-only boundary requires bubblewrap
// and the trusted platform OCR package; missing either fails closed. It assumes
// the host binary/package and checkout root are trusted and no same-user actor
// concurrently swaps checkout ancestors while it is bound into the namespace.
const BWRAP = "/usr/bin/bwrap";
const SANDBOX_REPO = "/repo";
const SANDBOX_OCR = "/ocr";
const OCR_TIMEOUT_MS = 30_000;

const getNativeOcr = async (): Promise<string> => {
  const packageName = `@alibaba-group/ocr-${process.platform}-${process.arch}`;
  const packageJson = require.resolve(`${packageName}/package.json`);
  const binary = await realpath(join(dirname(packageJson), "bin", "opencodereview"));
  if (!(await lstat(binary)).isFile()) {
    throw new Error("OCR binary is not a regular file");
  }
  return binary;
};

const sandboxArgs = (repo: string, binary: string, args: string[]): string[] => [
  "--unshare-all",
  "--die-with-parent",
  "--new-session",
  "--cap-drop", "ALL",
  "--ro-bind", "/usr", "/usr",
  "--ro-bind", "/bin", "/bin",
  "--ro-bind", "/lib", "/lib",
  "--ro-bind", "/lib64", "/lib64",
  "--ro-bind", binary, SANDBOX_OCR,
  "--ro-bind", repo, SANDBOX_REPO,
  "--proc", "/proc",
  "--dev", "/dev",
  "--tmpfs", "/tmp",
  "--dir", "/home",
  "--clearenv",
  "--setenv", "PATH", "/usr/bin:/bin",
  "--setenv", "HOME", "/tmp",
  "--setenv", "XDG_CONFIG_HOME", "/tmp/.config",
  "--setenv", "GIT_CONFIG_NOSYSTEM", "1",
  "--setenv", "GIT_CONFIG_GLOBAL", devNull,
  "--setenv", "GIT_ATTR_NOSYSTEM", "1",
  "--setenv", "GIT_TERMINAL_PROMPT", "0",
  "--setenv", "GIT_NO_REPLACE_OBJECTS", "1",
  "--setenv", "GIT_OPTIONAL_LOCKS", "0",
  "--setenv", "GIT_CONFIG_COUNT", "1",
  "--setenv", "GIT_CONFIG_KEY_0", "core.fsmonitor",
  "--setenv", "GIT_CONFIG_VALUE_0", "false",
  "--setenv", "GIT_PAGER", "cat",
  "--setenv", "OCR_NO_UPDATE", "1",
  "--chdir", SANDBOX_REPO,
  "--", SANDBOX_OCR,
  ...args.map((arg, index) =>
    index > 0 && args[index - 1] === "--repo" &&
    args.slice(0, index).indexOf("--") === -1
      ? SANDBOX_REPO
      : arg,
  ),
];

export type ReviewInput = {
  mode: "workspace" | "range" | "commit";
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
  ruleGroups: Array<{ files: string[]; rules: string }>;
};

export type RunOcr = (args: string[], repo: string) => Promise<string>;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonObject = (output: string, source: "preview" | "rule"): JsonObject => {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch (error) {
    throw new Error(`OCR ${source}: invalid JSON`, { cause: error });
  }
  if (!isObject(value)) {
    throw new Error(`OCR ${source}: output must be a JSON object`);
  }
  return value;
};

const requireSchemaVersion = (
  value: JsonObject,
  source: "preview" | "rule",
): void => {
  if (value.schema_version !== "1") {
    throw new Error(`OCR ${source}: unsupported schema_version`);
  }
};

const isMode = (value: unknown): value is ReviewInput["mode"] =>
  value === "workspace" || value === "range" || value === "commit";

const requireNonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
};

const requireCount = (value: unknown, field: string): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${field} must be a nonnegative safe integer`);
  }
  return value;
};

const parsePreview = (
  output: string,
): Pick<ReviewInput, "mode" | "files"> => {
  const preview = parseJsonObject(output, "preview");
  requireSchemaVersion(preview, "preview");
  if (!isMode(preview.mode)) {
    throw new Error("OCR preview: invalid mode");
  }
  if (!Array.isArray(preview.reviewable_files)) {
    throw new Error("OCR preview: reviewable_files must be an array");
  }
  if (preview.reviewable_files.length > 64) {
    throw new Error("OCR preview: expected at most 64 reviewable files");
  }

  const seenPaths = new Set<string>();
  const files = preview.reviewable_files.map((candidate, index) => {
    if (!isObject(candidate)) {
      throw new Error(`OCR preview: reviewable_files[${index}] must be an object`);
    }
    const path = requireNonEmptyString(
      candidate.path,
      `OCR preview: reviewable_files[${index}].path`,
    );
    if (seenPaths.has(path)) {
      throw new Error(`OCR preview: duplicate reviewable path: ${path}`);
    }
    seenPaths.add(path);

    return {
      path,
      status: requireNonEmptyString(
        candidate.status,
        `OCR preview: reviewable_files[${index}].status`,
      ),
      additions: requireCount(
        candidate.insertions,
        `OCR preview: reviewable_files[${index}].insertions`,
      ),
      deletions: requireCount(
        candidate.deletions,
        `OCR preview: reviewable_files[${index}].deletions`,
      ),
    };
  });

  return { mode: preview.mode, files };
};

const parseRuleGroups = (
  output: string,
  selectedPaths: string[],
): ReviewInput["ruleGroups"] => {
  const ruleOutput = parseJsonObject(output, "rule");
  requireSchemaVersion(ruleOutput, "rule");
  if (!Array.isArray(ruleOutput.groups)) {
    throw new Error("OCR rule: groups must be an array");
  }
  if (selectedPaths.length > 0 && ruleOutput.groups.length === 0) {
    throw new Error("OCR rule: groups must not be empty for selected paths");
  }

  const ruleGroups = ruleOutput.groups.map((candidate, index) => {
    if (!isObject(candidate)) {
      throw new Error(`OCR rule: groups[${index}] must be an object`);
    }
    if (!Array.isArray(candidate.files)) {
      throw new Error(`OCR rule: groups[${index}].files must be an array`);
    }
    if (candidate.files.length === 0) {
      throw new Error(`OCR rule: groups[${index}].files must not be empty`);
    }
    const files = candidate.files.map((file, fileIndex) =>
      requireNonEmptyString(
        file,
        `OCR rule: groups[${index}].files[${fileIndex}]`,
      ),
    );
    if (typeof candidate.rule !== "string") {
      throw new Error(`OCR rule: groups[${index}].rule must be a string`);
    }
    return { files, rules: candidate.rule };
  });

  const selectedPathSet = new Set(selectedPaths);
  const groupedPaths = new Set<string>();
  for (const groupedPath of ruleGroups.flatMap((group) => group.files)) {
    if (groupedPaths.has(groupedPath)) {
      throw new Error(`OCR rule: duplicate group path: ${groupedPath}`);
    }
    groupedPaths.add(groupedPath);
  }
  for (const groupedPath of groupedPaths) {
    if (!selectedPathSet.has(groupedPath)) {
      throw new Error(`OCR rule: group path was not selected: ${groupedPath}`);
    }
  }
  for (const selectedPath of selectedPaths) {
    if (!groupedPaths.has(selectedPath)) {
      throw new Error(
        `OCR rule: selected path missing from groups: ${selectedPath}`,
      );
    }
  }

  return ruleGroups;
};

export const runOcrProcess: RunOcr = async (args, repo) => {
  if (process.platform !== "linux" || !isAbsolute(repo)) {
    throw new Error("OCR collection requires an absolute repository path and a Linux sandbox");
  }
  const root = await realpath(repo);
  if (!(await lstat(root)).isDirectory()) {
    throw new Error("OCR repository root is not a directory");
  }
  const binary = await getNativeOcr();
  // OCR reads untrusted Git config and can execute repository helpers. Run it
  // behind a read-only, networkless mount namespace with no host secrets, not
  // merely a filtered host environment or Git command-line flags.
  const result = await execa(BWRAP, sandboxArgs(root, binary, args), {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    extendEnv: false,
    timeout: OCR_TIMEOUT_MS,
    reject: true,
    preferLocal: false,
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
};

export const createOcrAdapter = (runOcr: RunOcr = runOcrProcess) => ({
  async collect(repo: string): Promise<ReviewInput> {
    const previewOutput = await runOcr(
      ["delegate", "preview", "--format", "json", "--repo", repo],
      repo,
    );
    const { mode, files } = parsePreview(previewOutput);
    if (files.length === 0) {
      return { mode, files, ruleGroups: [] };
    }

    const ruleOutput = await runOcr(
      [
        "delegate",
        "rule",
        "--format",
        "json",
        "--repo",
        repo,
        "--",
        ...files.map((file) => file.path),
      ],
      repo,
    );

    return {
      mode,
      files,
      ruleGroups: parseRuleGroups(
        ruleOutput,
        files.map((file) => file.path),
      ),
    };
  },
});
