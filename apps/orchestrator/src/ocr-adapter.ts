import { execa } from "execa";

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
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${field} must be a nonnegative integer`);
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

const parseRuleGroups = (output: string): ReviewInput["ruleGroups"] => {
  const ruleOutput = parseJsonObject(output, "rule");
  requireSchemaVersion(ruleOutput, "rule");
  if (!Array.isArray(ruleOutput.groups)) {
    throw new Error("OCR rule: groups must be an array");
  }

  return ruleOutput.groups.map((candidate, index) => {
    if (!isObject(candidate)) {
      throw new Error(`OCR rule: groups[${index}] must be an object`);
    }
    if (!Array.isArray(candidate.files)) {
      throw new Error(`OCR rule: groups[${index}].files must be an array`);
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
};

export const runOcrProcess: RunOcr = async (args, repo) => {
  const result = await execa("ocr", args, {
    cwd: repo,
    timeout: 30_000,
    reject: true,
    preferLocal: true,
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

    return { mode, files, ruleGroups: parseRuleGroups(ruleOutput) };
  },
});
