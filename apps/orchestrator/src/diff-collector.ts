import { constants, type Stats } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import { execa } from "execa";

export const PER_FILE_DIFF_BYTES = 40 * 1024;
export const TOTAL_DIFF_BYTES = 80 * 1024;
export const MAX_REVIEW_FILES = 64;

const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
// Keep direct worktree reads bounded independently from Git's output buffer.
const MAX_RAW_FILE_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const MINIMAL_PATH = "/usr/bin:/bin";
const GIT_GLOBAL_OPTIONS = [
  "--no-lazy-fetch",
  "--no-replace-objects",
  "-c",
  "protocol.ext.allow=never",
] as const;

let trustedGitExecutablePromise: Promise<string> | undefined;

const getTrustedGitExecutable = (): Promise<string> => {
  trustedGitExecutablePromise ??= (async () => {
    const configured = process.env.TRUSTGATE_GIT_EXECUTABLE ?? "/usr/bin/git";
    if (!isAbsolute(configured)) {
      throw new Error("trusted Git executable must be an absolute path");
    }
    const resolvedExecutable = await realpath(configured);
    const executableStat = await lstat(resolvedExecutable);
    if (!executableStat.isFile()) {
      throw new Error("trusted Git executable must resolve to a regular file");
    }
    await access(resolvedExecutable, constants.X_OK);
    return resolvedExecutable;
  })();
  return trustedGitExecutablePromise;
};

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
  if (files.length > MAX_REVIEW_FILES) {
    throw new Error(`expected at most ${MAX_REVIEW_FILES} review files`);
  }

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

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const assertValidUtf8Text = (bytes: Buffer, filePath: string): void => {
  if (bytes.includes(0)) {
    return;
  }
  try {
    UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error(`review file contains invalid UTF-8: ${filePath}`);
  }
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

type GitFileMode = "100644" | "100755";
type HeadEntry = { mode: GitFileMode; oid: string };
type WorktreeEntry = { bytes: Buffer; mode: GitFileMode };

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
  PATH: MINIMAL_PATH,
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
  const gitExecutable = await getTrustedGitExecutable();
  const options = {
    cwd,
    env,
    extendEnv: false,
    timeout: GIT_TIMEOUT_MS,
    reject: true,
    preferLocal: false,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  } as const;
  const gitArgs = ["--no-pager", ...GIT_GLOBAL_OPTIONS, ...args];
  const result =
    input === undefined
      ? await execa(gitExecutable, gitArgs, options)
      : await execa(gitExecutable, gitArgs, { ...options, input });
  return result.stdout;
};

const gitBuffer = async (
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Buffer> => {
  const gitExecutable = await getTrustedGitExecutable();
  const result = await execa(
    gitExecutable,
    ["--no-pager", ...GIT_GLOBAL_OPTIONS, ...args],
    {
      cwd,
      env,
      extendEnv: false,
      encoding: "buffer",
      stripFinalNewline: false,
      timeout: GIT_TIMEOUT_MS,
      reject: true,
      preferLocal: false,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    },
  );
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

  return { mode, oid };
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

const pathExists = async (candidate: string): Promise<boolean> => {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const rejectObjectAlternates = async (gitDirectory: string): Promise<void> => {
  const infoDirectory = join(gitDirectory, "objects", "info");
  const alternatePaths = [
    join(infoDirectory, "alternates"),
    join(infoDirectory, "http-alternates"),
  ];
  if ((await Promise.all(alternatePaths.map(pathExists))).some(Boolean)) {
    throw new Error("repository object alternates are not allowed");
  }
};

const sameInode = (first: Stats, second: Stats): boolean =>
  first.dev === second.dev && first.ino === second.ino;

export const assertOpenedFileContained = async (
  root: string,
  candidate: string,
  handle: FileHandle,
  initialStat: Stats,
): Promise<Stats> => {
  const openedStat = await handle.stat();
  if (!openedStat.isFile() || !sameInode(openedStat, initialStat)) {
    throw new Error(`review file changed while opening: ${candidate}`);
  }

  if (process.platform === "linux") {
    const procFdPath = `/proc/self/fd/${handle.fd}`;
    let openedPath: string;
    try {
      openedPath = await realpath(procFdPath);
    } catch (error) {
      throw new Error(
        `cannot verify opened review file through procfs: ${candidate}`,
        { cause: error },
      );
    }
    const openedPathStat = await lstat(openedPath);
    if (
      !isStrictlyInside(root, openedPath) ||
      !sameInode(openedStat, openedPathStat)
    ) {
      throw new Error(`opened review file resolves outside repository: ${candidate}`);
    }
    return openedStat;
  }

  const resolvedCandidate = await realpath(candidate);
  const candidateStat = await lstat(resolvedCandidate);
  if (
    !isStrictlyInside(root, resolvedCandidate) ||
    !sameInode(openedStat, candidateStat)
  ) {
    throw new Error(`opened review file resolves outside repository: ${candidate}`);
  }
  return openedStat;
};

const readBoundedRegularFile = async (
  root: string,
  filePath: string,
): Promise<WorktreeEntry | null> => {
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
    const openedStat = await assertOpenedFileContained(
      root,
      candidate,
      handle,
      initialStat,
    );
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
        return {
          bytes: Buffer.concat(chunks, totalBytes),
          mode: (openedStat.mode & 0o111) === 0 ? "100644" : "100755",
        };
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
  await getTrustedGitExecutable();
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
    const expectedGitDirectory = join(root, ".git");
    const expectedGitStat = await lstat(expectedGitDirectory);
    if (!expectedGitStat.isDirectory() || expectedGitStat.isSymbolicLink()) {
      throw new Error("repository .git must be a real directory");
    }
    const expectedGitRealpath = await realpath(expectedGitDirectory);
    if (!isStrictlyInside(root, expectedGitRealpath)) {
      throw new Error("repository .git directory resolves outside repository root");
    }
    await rejectObjectAlternates(expectedGitRealpath);

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
    if (
      resolvedGitDirectory !== expectedGitRealpath ||
      commonGitDirectory !== expectedGitRealpath
    ) {
      throw new Error("repository returned an unexpected Git directory");
    }
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
    const currentEntry = await readBoundedRegularFile(root, normalizedPath);
    if (headEntry === null && currentEntry === null) {
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
    if (oldBytes.length > MAX_RAW_FILE_BYTES) {
      throw new Error(`review file exceeds raw byte limit: ${filePath}`);
    }
    assertValidUtf8Text(oldBytes, normalizedPath);
    if (currentEntry !== null) {
      assertValidUtf8Text(currentEntry.bytes, normalizedPath);
    }

    const zeroOid = "0".repeat(headOid.length);
    const oldOid =
      headEntry === null
        ? zeroOid
        : await gitText(
            [...isolatedArgs, "hash-object", "-w", "--no-filters", "--stdin"],
            context,
            isolatedEnv,
            oldBytes,
          );
    const newOid =
      currentEntry === null
        ? zeroOid
        : await gitText(
            [...isolatedArgs, "hash-object", "-w", "--no-filters", "--stdin"],
            context,
            isolatedEnv,
            currentEntry.bytes,
          );
    const oldMode = headEntry?.mode ?? "000000";
    const newMode = currentEntry?.mode ?? "000000";
    const status = headEntry === null ? "A" : currentEntry === null ? "D" : "M";
    const diffPair = Buffer.concat([
      Buffer.from(
        `:${oldMode} ${newMode} ${oldOid} ${newOid} ${status}\0`,
        "ascii",
      ),
      Buffer.from(normalizedPath, "utf8"),
      Buffer.from([0]),
    ]);

    return await gitText(
      [
        ...isolatedArgs,
        "diff-pairs",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
      ],
      context,
      isolatedEnv,
      diffPair,
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
