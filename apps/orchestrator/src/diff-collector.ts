import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { execa } from "execa";

export const PER_FILE_DIFF_BYTES = 40 * 1024;
export const TOTAL_DIFF_BYTES = 80 * 1024;

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
      const location = relativePath.length === 0 ? "repository root" : "outside repository";
      throw new Error(`review file path resolves to ${location}: ${filePath}`);
    }
    if (seenPaths.has(resolvedPath)) {
      throw new Error(`duplicate review file path: ${filePath}`);
    }
    if (isSecretLikePath(resolvedPath)) {
      throw new Error(`secret-like review file path is not allowed: ${filePath}`);
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

export const runGitDiffProcess: RunGitDiff = async (repo, filePath) => {
  // Literal pathspecs keep Git's matcher inside the selected-file security boundary.
  const result = await execa(
    "git",
    ["--literal-pathspecs", "diff", "HEAD", "--", filePath],
    {
      cwd: repo,
      timeout: 30_000,
      reject: true,
      preferLocal: false,
      maxBuffer: 1024 * 1024,
    },
  );
  return result.stdout;
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
