import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { execa } from "execa";

import {
  collectDiffs,
  PER_FILE_DIFF_BYTES,
  runGitDiffProcess,
  TOTAL_DIFF_BYTES,
  type ReviewFile,
  type RunGitDiff,
} from "../src/diff-collector.js";

const reviewFile = (path: string): ReviewFile => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 0,
});

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const initializeRepository = async (repo: string): Promise<void> => {
  const options = { cwd: repo, preferLocal: false } as const;
  await execa("git", ["init", "--quiet"], options);
  await execa("git", ["config", "user.email", "test@example.com"], options);
  await execa("git", ["config", "user.name", "Test User"], options);
};

test("collector rejects paths outside repository", async () => {
  await assert.rejects(() =>
    collectDiffs(
      "/repo",
      [
        {
          path: "../secret",
          status: "modified",
          additions: 1,
          deletions: 0,
        },
      ],
      async () => "x",
    ),
  );
});

test("collector truncates total diff input at 80 KiB", async () => {
  const result = await collectDiffs(
    "/repo",
    [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
      },
    ],
    async () => "x".repeat(100_000),
  );
  assert.equal(Buffer.byteLength(result[0]!.diff) <= 81_920, true);
  assert.equal(result[0]!.truncated, true);
});

test("collector truncates each file at 40 KiB", async () => {
  const result = await collectDiffs(
    "/repo",
    [reviewFile("src/a.ts")],
    async () => "x".repeat(PER_FILE_DIFF_BYTES + 1),
  );

  assert.equal(byteLength(result[0]!.diff), 40 * 1024);
  assert.equal(result[0]!.truncated, true);
});

test("collector preserves UTF-8 code point boundaries at a byte limit", async () => {
  const completePrefix = "a".repeat(PER_FILE_DIFF_BYTES - 1);
  const result = await collectDiffs(
    "/repo",
    [reviewFile("src/unicode.ts")],
    async () => `${completePrefix}😀`,
  );
  const diff = result[0]!.diff;

  assert.equal(diff, completePrefix);
  assert.equal(byteLength(diff) <= PER_FILE_DIFF_BYTES, true);
  assert.equal(Buffer.from(diff, "utf8").toString("utf8"), diff);
  assert.equal(diff.includes("\uFFFD"), false);
  assert.equal(result[0]!.truncated, true);
});

test("collector applies the total budget in input order and retains every result", async () => {
  const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"].map(
    reviewFile,
  );
  const outputs = new Map([
    [files[0]!.path, "a".repeat(PER_FILE_DIFF_BYTES)],
    [files[1]!.path, "b".repeat(PER_FILE_DIFF_BYTES - 5)],
    [files[2]!.path, "c".repeat(10)],
    [files[3]!.path, "d"],
  ]);
  const calls: string[] = [];
  const runGitDiff: RunGitDiff = async (_repo, path) => {
    calls.push(path);
    return outputs.get(path)!;
  };

  const result = await collectDiffs("/repo", files, runGitDiff);

  assert.deepEqual(
    result.map(({ path, truncated }) => ({ path, truncated })),
    [
      { path: "src/a.ts", truncated: false },
      { path: "src/b.ts", truncated: false },
      { path: "src/c.ts", truncated: true },
      { path: "src/d.ts", truncated: true },
    ],
  );
  assert.deepEqual(
    result.map(({ diff }) => byteLength(diff)),
    [PER_FILE_DIFF_BYTES, PER_FILE_DIFF_BYTES - 5, 5, 0],
  );
  assert.equal(
    result.reduce((total, { diff }) => total + byteLength(diff), 0),
    TOTAL_DIFF_BYTES,
  );
  assert.deepEqual(calls, ["src/a.ts", "src/b.ts", "src/c.ts"]);
});

test("collector preserves UTF-8 boundaries at the remaining total budget", async () => {
  const files = [
    "src/a.ts",
    "src/b.ts",
    "src/unicode.ts",
    "src/fill.ts",
    "src/skipped.ts",
  ].map(reviewFile);
  const outputs = new Map([
    [files[0]!.path, "a".repeat(PER_FILE_DIFF_BYTES)],
    [files[1]!.path, "b".repeat(PER_FILE_DIFF_BYTES - 3)],
    [files[2]!.path, "😀tail"],
    [files[3]!.path, "xyzmore"],
    [files[4]!.path, "not collected"],
  ]);
  const calls: string[] = [];

  const result = await collectDiffs("/repo", files, async (_repo, path) => {
    calls.push(path);
    return outputs.get(path)!;
  });

  assert.equal(result[2]!.diff, "");
  assert.equal(result[2]!.diff.includes("\uFFFD"), false);
  assert.equal(result[2]!.truncated, true);
  assert.equal(result[3]!.diff, "xyz");
  assert.equal(result[3]!.truncated, true);
  assert.deepEqual(result[4], {
    path: "src/skipped.ts",
    diff: "",
    truncated: true,
  });
  assert.equal(
    result.reduce((total, { diff }) => total + byteLength(diff), 0),
    TOTAL_DIFF_BYTES,
  );
  assert.deepEqual(calls, files.slice(0, 4).map(({ path }) => path));
});

test("collector validates the complete path list before invoking the runner", async () => {
  const invalidCases: Array<{ name: string; paths: string[]; error: RegExp }> = [
    { name: "empty", paths: ["src/safe.ts", ""], error: /non-empty/ },
    { name: "repository root", paths: ["src/safe.ts", "."], error: /root/ },
    {
      name: "outside repository",
      paths: ["src/safe.ts", "../secret"],
      error: /outside/,
    },
    {
      name: "absolute",
      paths: ["src/safe.ts", "/tmp/absolute.ts"],
      error: /absolute/,
    },
    {
      name: "NUL",
      paths: ["src/safe.ts", "src/bad\0name.ts"],
      error: /NUL/,
    },
    {
      name: "normalized duplicate",
      paths: ["src/a.ts", "src/other/../a.ts"],
      error: /duplicate/,
    },
  ];

  for (const { name, paths, error } of invalidCases) {
    let calls = 0;
    await assert.rejects(
      collectDiffs(
        "/repo",
        paths.map(reviewFile),
        async () => {
          calls += 1;
          return "diff";
        },
      ),
      error,
      name,
    );
    assert.equal(calls, 0, `${name}: runner was called before validation ended`);
  }
});

test("collector rejects secret-like basenames anywhere in the repository", async () => {
  const secretPaths = [
    "config/.env",
    "nested/config/.env.production",
    "nested/AUTH.JSON",
    "certificates/client.PEM",
    "keys/signing.Key",
  ];

  for (const secretPath of secretPaths) {
    let calls = 0;
    await assert.rejects(
      collectDiffs(
        "/repo",
        [reviewFile("src/safe.ts"), reviewFile(secretPath)],
        async () => {
          calls += 1;
          return "diff";
        },
      ),
      /secret-like/,
      secretPath,
    );
    assert.equal(calls, 0, `${secretPath}: runner was called before rejection`);
  }
});

test("collector accepts safe basenames that only resemble secret patterns", async () => {
  const paths = [
    "src/.environment.ts",
    "src/auth.json.ts",
    "docs/keynote.ts",
  ];
  const calls: string[] = [];

  const result = await collectDiffs(
    "/repo",
    paths.map(reviewFile),
    async (_repo, path) => {
      calls.push(path);
      return path;
    },
  );

  assert.deepEqual(calls, paths);
  assert.deepEqual(
    result.map(({ path }) => path),
    paths,
  );
});

test("collector handles the filesystem root as a repository boundary", async () => {
  const calls: Array<{ repo: string; path: string }> = [];

  const result = await collectDiffs(
    "/",
    [reviewFile("tmp/review.ts")],
    async (repo, path) => {
      calls.push({ repo, path });
      return "root diff";
    },
  );

  assert.deepEqual(calls, [{ repo: "/", path: "tmp/review.ts" }]);
  assert.deepEqual(result, [
    { path: "tmp/review.ts", diff: "root diff", truncated: false },
  ]);
});

test("collector does not mutate its input array or file objects", async () => {
  const first = Object.freeze(reviewFile("src/a.ts"));
  const second = Object.freeze(reviewFile("src/b.ts"));
  const files = Object.freeze([first, second]);
  const snapshot = structuredClone(files);

  const result = await collectDiffs(
    "/repo",
    files as unknown as ReviewFile[],
    async (_repo, path) => `diff:${path}`,
  );

  assert.deepEqual(files, snapshot);
  assert.deepEqual(result, [
    { path: "src/a.ts", diff: "diff:src/a.ts", truncated: false },
    { path: "src/b.ts", diff: "diff:src/b.ts", truncated: false },
  ]);
});

test("runGitDiffProcess passes an option-like path after Git's option terminator", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-option-diff-"));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  await initializeRepository(repo);

  await writeFile(join(repo, "--help"), "before\n");
  await writeFile(join(repo, "other.txt"), "other before\n");
  await execa("git", ["add", "--", "--help", "other.txt"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await writeFile(join(repo, "--help"), "after\n");
  await writeFile(join(repo, "other.txt"), "other after\n");

  const output = await runGitDiffProcess(repo, "--help");

  assert.match(output, /diff --git a\/--help b\/--help/);
  assert.match(output, /-before/);
  assert.match(output, /\+after/);
  assert.doesNotMatch(output, /other\.txt/);
});

test("runGitDiffProcess does not resolve Git from the target repository", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-hostile-git-"));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  await initializeRepository(repo);

  await writeFile(join(repo, "selected.txt"), "before\n");
  await execa("git", ["add", "--", "selected.txt"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await writeFile(join(repo, "selected.txt"), "after\n");

  const localBin = join(repo, "node_modules", ".bin");
  const marker = join(repo, "HOSTILE_LOCAL_GIT_EXECUTED");
  await mkdir(localBin, { recursive: true });
  await writeFile(
    join(localBin, "git"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
    { mode: 0o755 },
  );

  const output = await runGitDiffProcess(repo, "selected.txt");
  const hostileExecuted = await access(marker).then(
    () => true,
    () => false,
  );

  assert.equal(hostileExecuted, false);
  assert.match(output, /diff --git a\/selected\.txt b\/selected\.txt/);
});
