import assert from "node:assert/strict";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { execa } from "execa";

import {
  assertOpenedFileContained,
  collectDiffs,
  MAX_REVIEW_FILES,
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
  assert.deepEqual(
    calls,
    files.slice(0, 4).map(({ path }) => path),
  );
});

test("collector rejects more than 64 files before invoking the runner", async () => {
  let calls = 0;
  const tooMany = Array.from({ length: 65 }, (_, index) =>
    reviewFile(`src/file-${index}.ts`),
  );

  await assert.rejects(
    collectDiffs("/repo", tooMany, async () => {
      calls += 1;
      return "";
    }),
    /at most 64 review files/,
  );
  assert.equal(calls, 0);
});

test("collector accepts exactly 64 files", async () => {
  let calls = 0;
  const maximum = Array.from({ length: MAX_REVIEW_FILES }, (_, index) =>
    reviewFile(`src/file-${index}.ts`),
  );

  const result = await collectDiffs("/repo", maximum, async () => {
    calls += 1;
    return "";
  });

  assert.equal(calls, MAX_REVIEW_FILES);
  assert.equal(result.length, MAX_REVIEW_FILES);
});

test("collector validates the complete path list before invoking the runner", async () => {
  const invalidCases: Array<{ name: string; paths: string[]; error: RegExp }> =
    [
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
      collectDiffs("/repo", paths.map(reviewFile), async () => {
        calls += 1;
        return "diff";
      }),
      error,
      name,
    );
    assert.equal(
      calls,
      0,
      `${name}: runner was called before validation ended`,
    );
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
  const paths = ["src/.environment.ts", "src/auth.json.ts", "docs/keynote.ts"];
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

test("runGitDiffProcess treats a wildcard path as a literal filename", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-wildcard-diff-"));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  await initializeRepository(repo);

  await writeFile(join(repo, "*.txt"), "literal before\n");
  await writeFile(join(repo, "safe.txt"), "safe before\n");
  await writeFile(join(repo, ".env"), "secret before\n");
  await execa("git", ["add", "--", "*.txt", "safe.txt", ".env"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await writeFile(join(repo, "*.txt"), "literal after\n");
  await writeFile(join(repo, "safe.txt"), "safe after\n");
  await writeFile(join(repo, ".env"), "secret after\n");

  const output = await runGitDiffProcess(repo, "*.txt");

  assert.match(output, /-literal before/);
  assert.match(output, /\+literal after/);
  assert.doesNotMatch(output, /safe (?:before|after)/);
  assert.doesNotMatch(output, /secret (?:before|after)/);
});

test("runGitDiffProcess treats exclude magic as a literal filename", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-exclude-diff-"));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  await initializeRepository(repo);

  await writeFile(join(repo, ":(exclude)safe.txt"), "literal before\n");
  await writeFile(join(repo, "safe.txt"), "safe before\n");
  await writeFile(join(repo, ".env"), "secret before\n");
  await execa(
    "git",
    ["add", "--", ":(literal):(exclude)safe.txt", "safe.txt", ".env"],
    { cwd: repo, preferLocal: false },
  );
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await writeFile(join(repo, ":(exclude)safe.txt"), "literal after\n");
  await writeFile(join(repo, "safe.txt"), "safe after\n");
  await writeFile(join(repo, ".env"), "secret after\n");

  const output = await runGitDiffProcess(repo, ":(exclude)safe.txt");

  assert.match(output, /-literal before/);
  assert.match(output, /\+literal after/);
  assert.doesNotMatch(output, /safe (?:before|after)/);
  assert.doesNotMatch(output, /secret (?:before|after)/);
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

  assert.match(output, /-before/);
  assert.match(output, /\+after/);
  assert.doesNotMatch(output, /other (?:before|after)/);
});

test("runGitDiffProcess ignores hostile parent PATH", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-hostile-git-"));
  const hostileBin = await mkdtemp(join(tmpdir(), "trustgate-hostile-path-"));
  const marker = join(hostileBin, "HOSTILE_PATH_GIT_EXECUTED");
  const originalPath = process.env.PATH;
  t.after(async () => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await Promise.all([
      rm(repo, { recursive: true, force: true }),
      rm(hostileBin, { recursive: true, force: true }),
    ]);
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
  await writeFile(
    join(hostileBin, "git"),
    `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\nexit 93\n`,
    { mode: 0o755 },
  );
  process.env.PATH = hostileBin;

  const output = await runGitDiffProcess(repo, "selected.txt");

  await assert.rejects(access(marker));
  assert.match(output, /-before/);
  assert.match(output, /\+after/);
});

test("runner rejects a relative trusted Git executable override", async () => {
  const moduleUrl = new URL("../src/diff-collector.js", import.meta.url).href;
  const script = `
    process.env.TRUSTGATE_GIT_EXECUTABLE = "git";
    const { runGitDiffProcess } = await import(${JSON.stringify(moduleUrl)});
    try {
      await runGitDiffProcess("/tmp", "selected.txt");
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(String(error));
    }
  `;

  const result = await execa(
    process.execPath,
    ["--import", "tsx", "--eval", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, TRUSTGATE_GIT_EXECUTABLE: "git" },
      preferLocal: false,
    },
  );

  assert.match(result.stdout, /Git executable.*absolute/);
});

test("runner accepts a trusted absolute Git executable override", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-absolute-git-"));
  const wrapperDirectory = await mkdtemp(join(tmpdir(), "trustgate-git-wrapper-"));
  const wrapper = join(wrapperDirectory, "git");
  const marker = join(wrapperDirectory, "GIT_WRAPPER_EXECUTED");
  t.after(async () => {
    await Promise.all([
      rm(repo, { recursive: true, force: true }),
      rm(wrapperDirectory, { recursive: true, force: true }),
    ]);
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
  await writeFile(
    wrapper,
    `#!/bin/sh\nprintf '%s\\0' "$@" >> ${JSON.stringify(marker)}\nexec /usr/bin/git "$@"\n`,
    { mode: 0o755 },
  );

  const moduleUrl = new URL("../src/diff-collector.js", import.meta.url).href;
  const script = `
    const { runGitDiffProcess } = await import(${JSON.stringify(moduleUrl)});
    process.stdout.write(await runGitDiffProcess(${JSON.stringify(repo)}, "selected.txt"));
  `;
  const result = await execa(
    process.execPath,
    ["--import", "tsx", "--eval", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, TRUSTGATE_GIT_EXECUTABLE: wrapper },
      preferLocal: false,
    },
  );
  const invokedArguments = (await readFile(marker)).toString("utf8");

  assert.match(result.stdout, /-before/);
  assert.match(result.stdout, /\+after/);
  assert.match(invokedArguments, /--no-lazy-fetch\0/);
  assert.match(invokedArguments, /--no-replace-objects\0/);
  assert.match(invokedArguments, /protocol\.ext\.allow=never\0/);
});

test("target diff.external is never executed", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-external-diff-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
  await initializeRepository(repo);
  await writeFile(join(repo, "selected.txt"), "before\n");
  await writeFile(join(repo, ".env"), "EXTERNAL_DIFF_SECRET\n");
  await execa("git", ["add", "--", "selected.txt", ".env"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await writeFile(join(repo, "selected.txt"), "after\n");
  const marker = join(repo, "EXTERNAL_DIFF_EXECUTED");
  const helper = join(repo, "external.cjs");
  await writeFile(
    helper,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\nprocess.stdout.write(require("node:fs").readFileSync(".env"));\n`,
    { mode: 0o755 },
  );
  await execa("git", ["config", "diff.external", helper], {
    cwd: repo,
    preferLocal: false,
  });

  const output = await runGitDiffProcess(repo, "selected.txt");

  await assert.rejects(access(marker));
  assert.doesNotMatch(output, /EXTERNAL_DIFF_SECRET/);
  assert.match(output, /-before/);
  assert.match(output, /\+after/);
});

test("target attributes and clean filters are never executed", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-attributes-diff-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
  await initializeRepository(repo);
  const marker = join(repo, "ATTRIBUTE_HELPER_EXECUTED");
  const helper = join(repo, "filter.cjs");
  await writeFile(
    helper,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\nprocess.stdin.pipe(process.stdout);\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(repo, ".gitattributes"),
    "selected.txt filter=hostile diff=hostile\n",
  );
  await writeFile(join(repo, "selected.txt"), "raw before\n");
  await execa(
    "git",
    [
      "-c",
      `filter.hostile.clean=${helper}`,
      "-c",
      "filter.hostile.required=true",
      "add",
      "--",
      ".gitattributes",
      "selected.txt",
    ],
    { cwd: repo, preferLocal: false },
  );
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await rm(marker, { force: true });
  await execa("git", ["config", "filter.hostile.clean", helper], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["config", "filter.hostile.required", "true"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["config", "diff.hostile.command", helper], {
    cwd: repo,
    preferLocal: false,
  });
  await writeFile(join(repo, "selected.txt"), "raw after\n");

  const output = await runGitDiffProcess(repo, "selected.txt");

  await assert.rejects(access(marker));
  assert.match(output, /-raw before/);
  assert.match(output, /\+raw after/);
});

test("collector rejects directory paths without leaking descendants", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-directory-diff-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
  await initializeRepository(repo);
  await mkdir(join(repo, "selected"));
  await writeFile(join(repo, "selected", "safe.txt"), "safe\n");
  await writeFile(join(repo, "selected", ".env"), "DIRECTORY_SECRET\n");
  await execa("git", ["add", "--", "selected"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });

  await assert.rejects(
    collectDiffs(repo, [reviewFile("selected/")]),
    /regular|blob/,
  );
});

test("collector includes added and deleted regular files", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-add-delete-diff-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
  await initializeRepository(repo);
  await writeFile(join(repo, "deleted.txt"), "removed content\n");
  await execa("git", ["add", "--", "deleted.txt"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await rm(join(repo, "deleted.txt"));
  await writeFile(join(repo, "added.txt"), "new content\n");

  const result = await collectDiffs(repo, [
    { ...reviewFile("added.txt"), status: "added" },
    { ...reviewFile("deleted.txt"), status: "deleted" },
  ]);

  assert.match(result[0]!.diff, /\+new content/);
  assert.match(result[1]!.diff, /-removed content/);
  assert.deepEqual(
    result.map(({ truncated }) => truncated),
    [false, false],
  );
});

test("runner emits evidence for executable-bit-only changes", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-mode-diff-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
  await initializeRepository(repo);
  await writeFile(join(repo, "script.sh"), "#!/bin/sh\n", { mode: 0o644 });
  await execa("git", ["add", "--", "script.sh"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await chmod(join(repo, "script.sh"), 0o755);

  const output = await runGitDiffProcess(repo, "script.sh");

  assert.match(output, /old mode 100644/);
  assert.match(output, /new mode 100755/);
  assert.match(output, /diff --git a\/script\.sh b\/script\.sh/);
});

test("runner emits headers for empty added and deleted files", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-empty-diff-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
  await initializeRepository(repo);
  await writeFile(join(repo, "deleted-empty.txt"), "");
  await execa("git", ["add", "--", "deleted-empty.txt"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await rm(join(repo, "deleted-empty.txt"));
  await writeFile(join(repo, "added-empty.txt"), "");

  const [added, deleted] = await Promise.all([
    runGitDiffProcess(repo, "added-empty.txt"),
    runGitDiffProcess(repo, "deleted-empty.txt"),
  ]);

  assert.match(added, /new file mode 100644/);
  assert.match(added, /diff --git a\/added-empty\.txt b\/added-empty\.txt/);
  assert.match(deleted, /deleted file mode 100644/);
  assert.match(
    deleted,
    /diff --git a\/deleted-empty\.txt b\/deleted-empty\.txt/,
  );
});

test("opened-file containment rejects an outside descriptor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "trustgate-fd-root-"));
  const outside = await mkdtemp(join(tmpdir(), "trustgate-fd-outside-"));
  t.after(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });
  const candidate = join(root, "selected.txt");
  const outsideFile = join(outside, "selected.txt");
  await writeFile(candidate, "inside\n");
  await writeFile(outsideFile, "outside\n");
  const initialStat = await lstat(candidate);
  const handle = await open(outsideFile, "r");
  t.after(async () => handle.close());

  await assert.rejects(
    assertOpenedFileContained(root, candidate, handle, initialStat),
    /opened review file.*outside|changed while opening/,
  );
});

test("opened-file containment accepts the matching inside descriptor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "trustgate-fd-inside-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "selected.txt");
  await writeFile(candidate, "inside\n");
  const initialStat = await lstat(candidate);
  const handle = await open(candidate, "r");
  t.after(async () => handle.close());

  const openedStat = await assertOpenedFileContained(
    root,
    candidate,
    handle,
    initialStat,
  );

  assert.equal(openedStat.dev, initialStat.dev);
  assert.equal(openedStat.ino, initialStat.ino);
});

test("runner rejects non-NUL invalid UTF-8 worktree content", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-invalid-utf8-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
  await initializeRepository(repo);
  await writeFile(join(repo, "selected.txt"), "valid before\n");
  await execa("git", ["add", "--", "selected.txt"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await writeFile(
    join(repo, "selected.txt"),
    Buffer.from([0x76, 0x61, 0x6c, 0x69, 0x64, 0x20, 0xc3, 0x28, 0x0a]),
  );

  await assert.rejects(
    runGitDiffProcess(repo, "selected.txt"),
    /invalid UTF-8/,
  );
});

test("runner rejects non-NUL invalid UTF-8 HEAD content", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-invalid-head-utf8-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
  await initializeRepository(repo);
  await writeFile(
    join(repo, "selected.txt"),
    Buffer.from([0x68, 0x65, 0x61, 0x64, 0x20, 0xc3, 0x28, 0x0a]),
  );
  await execa("git", ["add", "--", "selected.txt"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await writeFile(join(repo, "selected.txt"), "valid after\n");

  await assert.rejects(
    runGitDiffProcess(repo, "selected.txt"),
    /invalid UTF-8/,
  );
});

test("runner preserves deterministic binary evidence for NUL content", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-binary-diff-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
  await initializeRepository(repo);
  await writeFile(join(repo, "selected.bin"), Buffer.from([0, 1, 2]));
  await execa("git", ["add", "--", "selected.bin"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await writeFile(join(repo, "selected.bin"), Buffer.from([0, 1, 3]));

  const output = await runGitDiffProcess(repo, "selected.bin");

  assert.match(output, /Binary files .* differ/);
  assert.doesNotMatch(output, /\uFFFD/);
});

test("runner rejects symlinks, intermediate escapes, and gitlinks", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-special-path-"));
  const outside = await mkdtemp(join(tmpdir(), "trustgate-special-outside-"));
  const child = await mkdtemp(join(tmpdir(), "trustgate-special-child-"));
  t.after(async () => {
    await Promise.all([
      rm(repo, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
      rm(child, { recursive: true, force: true }),
    ]);
  });
  await initializeRepository(repo);
  await initializeRepository(child);
  await writeFile(join(child, "child.txt"), "child\n");
  await execa("git", ["add", "--", "child.txt"], {
    cwd: child,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "child"], {
    cwd: child,
    preferLocal: false,
  });
  const childHead = (
    await execa("git", ["rev-parse", "HEAD"], {
      cwd: child,
      preferLocal: false,
    })
  ).stdout;
  await mkdir(join(repo, "escape"));
  await writeFile(join(repo, "escape", "secret.txt"), "safe\n");
  await symlink(join(outside, "secret.txt"), join(repo, "tracked-link"));
  await execa("git", ["add", "--", "escape/secret.txt", "tracked-link"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa(
    "git",
    ["update-index", "--add", "--cacheinfo", "160000", childHead, "module"],
    { cwd: repo, preferLocal: false },
  );
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await rm(join(repo, "escape"), { recursive: true });
  await writeFile(join(outside, "secret.txt"), "OUTSIDE_SECRET\n");
  await symlink(outside, join(repo, "escape"));
  await symlink(join(outside, "secret.txt"), join(repo, "untracked-link"));

  await assert.rejects(runGitDiffProcess(repo, "tracked-link"), /regular|blob/);
  await assert.rejects(
    runGitDiffProcess(repo, "untracked-link"),
    /regular|blob|outside repository/,
  );
  await assert.rejects(runGitDiffProcess(repo, "module"), /regular Git blob/);
  await assert.rejects(
    runGitDiffProcess(repo, "escape/secret.txt"),
    /outside repository/,
  );
});

test("target core.fsmonitor helper is never executed", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-fsmonitor-diff-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
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
  const marker = join(repo, "FSMONITOR_EXECUTED");
  const helper = join(repo, "fsmonitor.cjs");
  await writeFile(
    helper,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\nprocess.stdout.write("\\n");\n`,
    { mode: 0o755 },
  );
  await execa("git", ["config", "core.fsmonitor", helper], {
    cwd: repo,
    preferLocal: false,
  });

  const output = await runGitDiffProcess(repo, "selected.txt");

  await assert.rejects(access(marker));
  assert.match(output, /-before/);
  assert.match(output, /\+after/);
});

test("runner enforces raw byte caps for HEAD and worktree content", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-large-raw-diff-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
  await initializeRepository(repo);
  await writeFile(join(repo, "large.txt"), Buffer.alloc(1024 * 1024 + 1));
  await execa("git", ["add", "--", "large.txt"], {
    cwd: repo,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: repo,
    preferLocal: false,
  });
  await rm(join(repo, "large.txt"));

  await assert.rejects(runGitDiffProcess(repo, "large.txt"));

  await writeFile(join(repo, "large.txt"), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(
    runGitDiffProcess(repo, "large.txt"),
    /exceeds raw byte limit/,
  );
});

test("runner rejects object alternates before object access", async (t) => {
  for (const alternateName of ["alternates", "http-alternates"]) {
    await t.test(alternateName, async (t) => {
      const repo = await mkdtemp(join(tmpdir(), "trustgate-alternates-diff-"));
      t.after(async () => rm(repo, { recursive: true, force: true }));
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
      await mkdir(join(repo, ".git", "objects", "info"), { recursive: true });
      await writeFile(
        join(repo, ".git", "objects", "info", alternateName),
        alternateName === "alternates"
          ? "/definitely/not/an/object/directory\n"
          : "https://example.invalid/objects\n",
      );

      await assert.rejects(
        runGitDiffProcess(repo, "selected.txt"),
        /object alternates are not allowed/,
      );
    });
  }
});

test("runner rejects dangling object-alternate symlinks", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-alternate-link-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
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
  await mkdir(join(repo, ".git", "objects", "info"), { recursive: true });
  await symlink(
    "/definitely/missing/alternates",
    join(repo, ".git", "objects", "info", "alternates"),
  );

  await assert.rejects(
    runGitDiffProcess(repo, "selected.txt"),
    /object alternates are not allowed/,
  );
});

test("runner supports normal SHA-256 repositories", async (t) => {
  const shaRepo = await mkdtemp(join(tmpdir(), "trustgate-sha256-diff-"));
  t.after(async () => rm(shaRepo, { recursive: true, force: true }));

  const shaOptions = { cwd: shaRepo, preferLocal: false } as const;
  await execa("git", ["init", "--quiet", "--object-format=sha256"], shaOptions);
  await execa("git", ["config", "user.email", "test@example.com"], shaOptions);
  await execa("git", ["config", "user.name", "Test User"], shaOptions);
  await writeFile(join(shaRepo, "selected.txt"), "before sha256\n");
  await execa("git", ["add", "--", "selected.txt"], shaOptions);
  await execa("git", ["commit", "--quiet", "-m", "initial"], shaOptions);
  await writeFile(join(shaRepo, "selected.txt"), "after sha256\n");

  const shaOutput = await runGitDiffProcess(shaRepo, "selected.txt");

  assert.match(shaOutput, /-before sha256/);
  assert.match(shaOutput, /\+after sha256/);
});

test("runner rejects linked worktree Git-file indirection", async (t) => {
  const mainRepo = await mkdtemp(join(tmpdir(), "trustgate-main-worktree-"));
  const linked = await mkdtemp(join(tmpdir(), "trustgate-linked-worktree-"));
  await rm(linked, { recursive: true, force: true });
  t.after(async () => {
    await Promise.all([
      rm(mainRepo, { recursive: true, force: true }),
      rm(linked, { recursive: true, force: true }),
    ]);
  });
  await initializeRepository(mainRepo);
  await writeFile(join(mainRepo, "selected.txt"), "before linked\n");
  await execa("git", ["add", "--", "selected.txt"], {
    cwd: mainRepo,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: mainRepo,
    preferLocal: false,
  });
  await execa(
    "git",
    ["worktree", "add", "--quiet", "--detach", linked, "HEAD"],
    { cwd: mainRepo, preferLocal: false },
  );

  await assert.rejects(
    runGitDiffProcess(linked, "selected.txt"),
    /\.git.*real directory|Git directory/,
  );
});

test("runner rejects .git symlinks and arbitrary Git-file indirection", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "trustgate-gitdir-source-"));
  const symlinkRepo = await mkdtemp(join(tmpdir(), "trustgate-gitdir-symlink-"));
  const fileRepo = await mkdtemp(join(tmpdir(), "trustgate-gitdir-file-"));
  t.after(async () => {
    await Promise.all([
      rm(source, { recursive: true, force: true }),
      rm(symlinkRepo, { recursive: true, force: true }),
      rm(fileRepo, { recursive: true, force: true }),
    ]);
  });
  await initializeRepository(source);
  await writeFile(join(source, "selected.txt"), "tracked\n");
  await execa("git", ["add", "--", "selected.txt"], {
    cwd: source,
    preferLocal: false,
  });
  await execa("git", ["commit", "--quiet", "-m", "initial"], {
    cwd: source,
    preferLocal: false,
  });
  await symlink(join(source, ".git"), join(symlinkRepo, ".git"));
  await writeFile(
    join(fileRepo, ".git"),
    `gitdir: ${join(source, ".git")}\n`,
  );
  await writeFile(join(symlinkRepo, "selected.txt"), "changed\n");
  await writeFile(join(fileRepo, "selected.txt"), "changed\n");

  await assert.rejects(
    runGitDiffProcess(symlinkRepo, "selected.txt"),
    /\.git.*real directory|Git directory/,
  );
  await assert.rejects(
    runGitDiffProcess(fileRepo, "selected.txt"),
    /\.git.*real directory|Git directory/,
  );
});
