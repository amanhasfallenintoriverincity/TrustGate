import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { execa } from "execa";

export const PER_FILE_DIFF_BYTES = 40 * 1024;
export const TOTAL_DIFF_BYTES = 80 * 1024;

const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
// Keep direct worktree reads bounded independently from Git's output buffer.
const MAX_RAW_FILE_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

export type FileDiff = { path: string; diff: string; truncated: boolean };

export type ReviewFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export type RunGitDiff = (repo: string, path: string) => Promise<string>;

type ValidatedFile = { path: string; resolvedPath: string };

const isSecretLikePath = (resolvedPath: string): boolean => {
  const fileName = basename(resolvedPath).toLowerCase();
  return (
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
    fileName === "auth.json" ||
    fileName.endsWith(".pem") ||
    fileName.endsWith(".key")
  );
};

const validateFiles = (root: string, files: ReviewFile[]): ValidatedFile[] => {
  const seenPaths = new Set<string>();

  return files.map((file, index) => {
    const filePath: unknown = file?.path;
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error(`review files[${index}].path must be a non-empty string`);
    }
    if (filePath.includes("\0")) {
      throw new Error(`review file path contains NUL: ${filePath}`);
    }
    if (isAbsolute(filePath)) {
      throw new Error(`review file path must not be absolute: ${filePath}`);
    }

    const resolvedPath = resolve(root, filePath);
    const relativePath = relative(root, resolvedPath);
    if (
      relativePath.length === 0 ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      const location =
        relativePath.length === 0 ? "repository root" : "outside repository";
      throw new Error(`review file path resolves to ${location}: ${filePath}`);
    }
    if (seenPaths.has(resolvedPath)) {
      throw new Error(`duplicate review file path: ${filePath}`);
    }
    if (isSecretLikePath(resolvedPath)) {
      throw new Error(
        `secret-like review file path is not allowed: ${filePath}`,
      );
    }

    seenPaths.add(resolvedPath);
    return { path: filePath, resolvedPath };
  });
};

const truncateUtf8 = (
  value: string,
  byteLimit: number,
): { value: string; bytes: number; truncated: boolean } => {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= byteLimit) {
    return { value, bytes: encoded.length, truncated: false };
  }

  let end = byteLimit;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  const truncatedValue = encoded.subarray(0, end).toString("utf8");
  return { value: truncatedValue, bytes: end, truncated: true };
};

type HeadEntry = { oid: string };

const isStrictlyInside = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
};

const isolatedGitEnvironment = (
  home: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: devNull,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  LC_ALL: "C",
  LANG: "C",
  ...extra,
});

const gitText = async (
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: Buffer,
): Promise<string> => {
  const options = {
    cwd,
    env,
    extendEnv: false,
    timeout: GIT_TIMEOUT_MS,
    reject: true,
    preferLocal: false,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  } as const;
  const result =
    input === undefined
      ? await execa("git", ["--no-pager", ...args], options)
      : await execa("git", ["--no-pager", ...args], { ...options, input });
  return result.stdout;
};

const gitBuffer = async (
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Buffer> => {
  const result = await execa("git", ["--no-pager", ...args], {
    cwd,
    env,
    extendEnv: false,
    encoding: "buffer",
    stripFinalNewline: false,
    timeout: GIT_TIMEOUT_MS,
    reject: true,
    preferLocal: false,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  return Buffer.from(result.stdout);
};

const parseHeadEntry = (output: Buffer, filePath: string): HeadEntry | null => {
  if (output.length === 0) {
    return null;
  }

  const records = output
    .subarray(0, output.length - 1)
    .toString("binary")
    .split("\0");
  if (output[output.length - 1] !== 0 || records.length !== 1) {
    throw new Error(`unexpected Git tree result for review file: ${filePath}`);
  }

  const record = Buffer.from(records[0]!, "binary");
  const tabIndex = record.indexOf(0x09);
  if (
    tabIndex < 0 ||
    !record.subarray(tabIndex + 1).equals(Buffer.from(filePath))
  ) {
    throw new Error(`Git tree returned a different review file: ${filePath}`);
  }

  const [mode, type, oid, extra] = record
    .subarray(0, tabIndex)
    .toString("ascii")
    .split(" ");
  if (extra !== undefined || oid === undefined) {
    throw new Error(
      `unexpected Git tree metadata for review file: ${filePath}`,
    );
  }
  if ((mode !== "100644" && mode !== "100755") || type !== "blob") {
    throw new Error(`review file is not a regular Git blob: ${filePath}`);
  }

  return { oid };
};

const resolveExistingAncestor = async (candidate: string): Promise<string> => {
  let ancestor = candidate;
  let suffix = "";
  while (true) {
    try {
      return resolve(await realpath(ancestor), suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = resolve(ancestor, "..");
      if (parent === ancestor) {
        throw error;
      }
      suffix = join(basename(ancestor), suffix);
      ancestor = parent;
    }
  }
};

const readBoundedRegularFile = async (
  root: string,
  filePath: string,
): Promise<Buffer | null> => {
  const candidate = resolve(root, filePath);
  if (!isStrictlyInside(root, candidate)) {
    throw new Error(
      `review file path resolves outside repository: ${filePath}`,
    );
  }

  const resolvedCandidate = await resolveExistingAncestor(candidate);
  if (!isStrictlyInside(root, resolvedCandidate)) {
    throw new Error(`review file resolves outside repository: ${filePath}`);
  }

  let initialStat;
  try {
    initialStat = await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!initialStat.isFile()) {
    throw new Error(`review file is not a regular worktree file: ${filePath}`);
  }

  const handle = await open(
    candidate,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== initialStat.dev ||
      openedStat.ino !== initialStat.ino
    ) {
      throw new Error(`review file changed while opening: ${filePath}`);
    }
    if (openedStat.size > MAX_RAW_FILE_BYTES) {
      throw new Error(`review file exceeds raw byte limit: ${filePath}`);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_RAW_FILE_BYTES) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, MAX_RAW_FILE_BYTES + 1 - totalBytes),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes);
      }
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    throw new Error(`review file exceeds raw byte limit: ${filePath}`);
  } finally {
    await handle.close();
  }
};

export const runGitDiffProcess: RunGitDiff = async (repo, filePath) => {
  const lexicalRoot = resolve(repo);
  if (
    typeof filePath !== "string" ||
    filePath.length === 0 ||
    filePath.includes("\0") ||
    isAbsolute(filePath)
  ) {
    throw new Error(`invalid review file path: ${filePath}`);
  }

  const context = await mkdtemp(join(tmpdir(), "trustgate-isolated-diff-"));
  const home = join(context, "home");
  const bareRepo = join(context, "objects.git");

  try {
    await mkdir(home, { recursive: true });
    const root = await realpath(lexicalRoot);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) {
      throw new Error(`repository root is not a directory: ${repo}`);
    }

    const discoveryEnv = isolatedGitEnvironment(home);
    const discoveryArgs = [
      "-c",
      `core.worktree=${root}`,
      "-c",
      "core.bare=false",
      "-c",
      "core.fsmonitor=false",
      "-C",
      root,
    ];
    const topLevel = await gitText(
      [
        ...discoveryArgs,
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
      ],
      root,
      discoveryEnv,
    );
    if ((await realpath(topLevel)) !== root) {
      throw new Error(`repository argument is not the worktree root: ${repo}`);
    }

    const [headOid, objectFormat, gitDirectory, commonDirectory] =
      await Promise.all([
        gitText(
          [...discoveryArgs, "rev-parse", "--verify", "HEAD^{commit}"],
          root,
          discoveryEnv,
        ),
        gitText(
          [...discoveryArgs, "rev-parse", "--show-object-format=storage"],
          root,
          discoveryEnv,
        ),
        gitText(
          [
            ...discoveryArgs,
            "rev-parse",
            "--path-format=absolute",
            "--absolute-git-dir",
          ],
          root,
          discoveryEnv,
        ),
        gitText(
          [
            ...discoveryArgs,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ],
          root,
          discoveryEnv,
        ),
      ]);
    const oidPattern =
      objectFormat === "sha1"
        ? /^[0-9a-f]{40}$/
        : objectFormat === "sha256"
          ? /^[0-9a-f]{64}$/
          : null;
    if (oidPattern === null || !oidPattern.test(headOid)) {
      throw new Error("repository returned invalid object metadata");
    }
    const [resolvedGitDirectory, commonGitDirectory] = await Promise.all([
      realpath(gitDirectory),
      realpath(commonDirectory),
    ]);
    const [gitDirectoryStat, commonGitStat] = await Promise.all([
      lstat(resolvedGitDirectory),
      lstat(commonGitDirectory),
    ]);
    if (!gitDirectoryStat.isDirectory() || !commonGitStat.isDirectory()) {
      throw new Error("repository returned an invalid Git directory");
    }
    const commonRelationship = relative(
      commonGitDirectory,
      resolvedGitDirectory,
    );
    if (
      commonRelationship === ".." ||
      commonRelationship.startsWith(`..${sep}`) ||
      isAbsolute(commonRelationship)
    ) {
      throw new Error(
        "repository Git directory is outside its common directory",
      );
    }
    const objects = await realpath(join(commonGitDirectory, "objects"));

    await gitText(
      [
        "init",
        "--quiet",
        "--bare",
        `--object-format=${objectFormat}`,
        "--template=",
        bareRepo,
      ],
      context,
      isolatedGitEnvironment(home),
    );

    const isolatedEnv = isolatedGitEnvironment(home, {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objects,
    });
    const isolatedArgs = ["--git-dir", bareRepo];
    const normalizedPath = relative(root, resolve(root, filePath))
      .split(sep)
      .join("/");
    if (
      normalizedPath.length === 0 ||
      normalizedPath === ".." ||
      normalizedPath.startsWith("../")
    ) {
      throw new Error(
        `review file path resolves outside repository: ${filePath}`,
      );
    }

    const treeOutput = await gitBuffer(
      [
        ...isolatedArgs,
        "--literal-pathspecs",
        "ls-tree",
        "-z",
        headOid,
        "--",
        normalizedPath,
      ],
      context,
      isolatedEnv,
    );
    const headEntry = parseHeadEntry(treeOutput, normalizedPath);
    const currentBytes = await readBoundedRegularFile(root, normalizedPath);
    if (headEntry === null && currentBytes === null) {
      throw new Error(
        `review file does not exist in HEAD or worktree: ${filePath}`,
      );
    }

    const oldBytes =
      headEntry === null
        ? Buffer.alloc(0)
        : await gitBuffer(
            [...isolatedArgs, "cat-file", "blob", headEntry.oid],
            context,
            isolatedEnv,
          );
    const newBytes = currentBytes ?? Buffer.alloc(0);
    const oldOid = await gitText(
      [...isolatedArgs, "hash-object", "-w", "--no-filters", "--stdin"],
      context,
      isolatedEnv,
      oldBytes,
    );
    const newOid = await gitText(
      [...isolatedArgs, "hash-object", "-w", "--no-filters", "--stdin"],
      context,
      isolatedEnv,
      newBytes,
    );

    return await gitText(
      [
        ...isolatedArgs,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        oldOid,
        newOid,
      ],
      context,
      isolatedEnv,
    );
  } finally {
    await rm(context, { recursive: true, force: true });
  }
};

export async function collectDiffs(
  repo: string,
  files: ReviewFile[],
  runGitDiff: RunGitDiff = runGitDiffProcess,
): Promise<FileDiff[]> {
  const root = resolve(repo);
  const validatedFiles = validateFiles(root, files);
  const results: FileDiff[] = [];
  let remainingBytes = TOTAL_DIFF_BYTES;

  for (const file of validatedFiles) {
    if (remainingBytes === 0) {
      results.push({ path: file.path, diff: "", truncated: true });
      continue;
    }

    const output = await runGitDiff(root, file.path);
    const retained = truncateUtf8(
      output,
      Math.min(PER_FILE_DIFF_BYTES, remainingBytes),
    );
    remainingBytes -= retained.bytes;
    results.push({
      path: file.path,
      diff: retained.value,
      truncated: retained.truncated,
    });
  }

  return results;
}
