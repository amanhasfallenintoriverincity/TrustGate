import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createOcrAdapter,
  runOcrProcess,
  type RunOcr,
} from "../src/ocr-adapter.js";

const previewFixture = await readFile(
  new URL("./fixtures/preview.json", import.meta.url),
  "utf8",
);
const ruleFixture = await readFile(
  new URL("./fixtures/rule.json", import.meta.url),
  "utf8",
);

const validPreview = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema_version: "1",
    mode: "workspace",
    reviewable_files: [
      {
        path: "src/routes/purchase.ts",
        status: "modified",
        insertions: 4,
        deletions: 1,
      },
    ],
    ...overrides,
  });

const previewWithPaths = (paths: string[]): string =>
  validPreview({
    reviewable_files: paths.map((path) => ({
      path,
      status: "modified",
      insertions: 1,
      deletions: 0,
    })),
  });

const validRule = (groups: Array<{ files: string[]; rule: string }>): string =>
  JSON.stringify({ schema_version: "1", groups });

const createFixtureRunner = (
  previewOutput: string,
  ruleOutput = ruleFixture,
): { runOcr: RunOcr; calls: Array<{ args: string[]; repo: string }> } => {
  const calls: Array<{ args: string[]; repo: string }> = [];
  const runOcr: RunOcr = async (args, repo) => {
    calls.push({ args, repo });
    if (args[1] === "preview") return previewOutput;
    if (args[1] === "rule") return ruleOutput;
    throw new Error(`Unexpected OCR command: ${args.join(" ")}`);
  };
  return { runOcr, calls };
};

test("runOcrProcess ignores an executable in the target repository", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "trustgate-hostile-ocr-"));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const binDirectory = join(repo, "node_modules", ".bin");
  const marker = join(repo, "HOSTILE_REPO_BINARY_EXECUTED");
  await mkdir(binDirectory, { recursive: true });
  await writeFile(
    join(binDirectory, "ocr"),
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\nconsole.log("HOSTILE_REPO_BINARY_EXECUTED");\n`,
    { mode: 0o755 },
  );

  const output = await runOcrProcess(["--version"], repo);
  const hostileExecuted = await access(marker).then(
    () => true,
    () => false,
  );

  assert.equal(hostileExecuted, false, "the target repository binary ran");
  assert.match(output, /^open-code-review v1\.12\.6\b/);
});

test("preview and rule calls are converted into review input", async () => {
  const { runOcr, calls } = createFixtureRunner(previewFixture);

  const input = await createOcrAdapter(runOcr).collect("/repo");

  assert.deepEqual(calls, [
    {
      args: ["delegate", "preview", "--format", "json", "--repo", "/repo"],
      repo: "/repo",
    },
    {
      args: [
        "delegate",
        "rule",
        "--format",
        "json",
        "--repo",
        "/repo",
        "--",
        "src/routes/purchase.ts",
      ],
      repo: "/repo",
    },
  ]);
  assert.deepEqual(input, {
    mode: "workspace",
    files: [
      {
        path: "src/routes/purchase.ts",
        status: "modified",
        additions: 4,
        deletions: 1,
      },
    ],
    ruleGroups: [
      {
        files: ["src/routes/purchase.ts"],
        rules: "never trust client price",
      },
    ],
  });
});

test("option-like file paths are passed after the option terminator", async () => {
  const path = "--help";
  const { runOcr, calls } = createFixtureRunner(
    validPreview({
      reviewable_files: [
        { path, status: "added", insertions: 1, deletions: 0 },
      ],
    }),
    JSON.stringify({
      schema_version: "1",
      groups: [{ files: [path], rule: "review it" }],
    }),
  );

  await createOcrAdapter(runOcr).collect("/repo");

  assert.deepEqual(calls[1]?.args.slice(-2), ["--", path]);
});

test("an empty preview returns no groups without calling rule", async () => {
  const { runOcr, calls } = createFixtureRunner(
    validPreview({ reviewable_files: [] }),
  );

  const input = await createOcrAdapter(runOcr).collect("/repo");

  assert.deepEqual(input, { mode: "workspace", files: [], ruleGroups: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.args[1], "preview");
});

test("malformed preview JSON rejects", async () => {
  const { runOcr } = createFixtureRunner("{");
  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /OCR preview: invalid JSON/,
  );
});

test("unsupported preview schema_version rejects", async () => {
  const { runOcr } = createFixtureRunner(
    validPreview({ schema_version: "2" }),
  );
  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /OCR preview: unsupported schema_version/,
  );
});

test("invalid preview mode rejects", async () => {
  const { runOcr } = createFixtureRunner(validPreview({ mode: "staged" }));
  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /OCR preview: invalid mode/,
  );
});

test("negative counts reject", async () => {
  const { runOcr } = createFixtureRunner(
    validPreview({
      reviewable_files: [
        {
          path: "src/routes/purchase.ts",
          status: "modified",
          insertions: -1,
          deletions: 1,
        },
      ],
    }),
  );
  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /insertions must be a nonnegative safe integer/,
  );
});

test("non-integer counts reject", async () => {
  const { runOcr } = createFixtureRunner(
    validPreview({
      reviewable_files: [
        {
          path: "src/routes/purchase.ts",
          status: "modified",
          insertions: 4,
          deletions: 0.5,
        },
      ],
    }),
  );
  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /deletions must be a nonnegative safe integer/,
  );
});

test("unsafe integer insertion counts reject", async () => {
  const { runOcr } = createFixtureRunner(
    validPreview({
      reviewable_files: [
        {
          path: "src/routes/purchase.ts",
          status: "modified",
          insertions: Number.MAX_SAFE_INTEGER + 1,
          deletions: 1,
        },
      ],
    }),
  );
  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /insertions must be a nonnegative safe integer/,
  );
});

test("unsafe integer deletion counts reject", async () => {
  const { runOcr } = createFixtureRunner(
    validPreview({
      reviewable_files: [
        {
          path: "src/routes/purchase.ts",
          status: "modified",
          insertions: 1,
          deletions: Number.MAX_SAFE_INTEGER + 1,
        },
      ],
    }),
  );
  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /deletions must be a nonnegative safe integer/,
  );
});

test("malformed reviewable files reject", async () => {
  const { runOcr } = createFixtureRunner(
    validPreview({
      reviewable_files: [
        {
          path: "",
          status: "modified",
          insertions: 4,
          deletions: 1,
        },
      ],
    }),
  );
  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /path must be a non-empty string/,
  );
});

test("duplicate reviewable paths reject", async () => {
  const duplicate = {
    path: "src/routes/purchase.ts",
    status: "modified",
    insertions: 4,
    deletions: 1,
  };
  const { runOcr } = createFixtureRunner(
    validPreview({ reviewable_files: [duplicate, duplicate] }),
  );
  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /OCR preview: duplicate reviewable path/,
  );
});

test("malformed rule JSON rejects", async () => {
  const { runOcr } = createFixtureRunner(validPreview(), "{");
  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /OCR rule: invalid JSON/,
  );
});

test("unsupported rule schema_version rejects", async () => {
  const { runOcr } = createFixtureRunner(
    validPreview(),
    JSON.stringify({ schema_version: "2", groups: [] }),
  );
  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /OCR rule: unsupported schema_version/,
  );
});

test("malformed rule groups reject", async () => {
  const malformedGroups = [
    { groups: "not-an-array", error: /OCR rule: groups must be an array/ },
    { groups: [null], error: /OCR rule: groups\[0\] must be an object/ },
    {
      groups: [{ files: "src/routes/purchase.ts", rule: "rule" }],
      error: /OCR rule: groups\[0\]\.files must be an array/,
    },
    {
      groups: [{ files: [""], rule: "rule" }],
      error: /OCR rule: groups\[0\]\.files\[0\] must be a non-empty string/,
    },
    {
      groups: [{ files: ["src/routes/purchase.ts"] }],
      error: /OCR rule: groups\[0\]\.rule must be a string/,
    },
  ];

  for (const { groups, error } of malformedGroups) {
    const { runOcr } = createFixtureRunner(
      validPreview(),
      JSON.stringify({ schema_version: "1", groups }),
    );
    await assert.rejects(createOcrAdapter(runOcr).collect("/repo"), error);
  }
});

test("rule groups must cover every selected path", async () => {
  const { runOcr } = createFixtureRunner(
    previewWithPaths(["src/a.ts", "src/b.ts"]),
    validRule([{ files: ["src/a.ts"], rule: "review a" }]),
  );

  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /OCR rule: selected path missing from groups: src\/b\.ts/,
  );
});

test("rule groups reject a path not selected by preview", async () => {
  const { runOcr } = createFixtureRunner(
    previewWithPaths(["src/a.ts"]),
    validRule([
      { files: ["src/a.ts"], rule: "review a" },
      { files: ["src/unknown.ts"], rule: "review unknown" },
    ]),
  );

  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /OCR rule: group path was not selected: src\/unknown\.ts/,
  );
});

test("rule groups reject duplicate membership across groups", async () => {
  const { runOcr } = createFixtureRunner(
    previewWithPaths(["src/a.ts"]),
    validRule([
      { files: ["src/a.ts"], rule: "first rule" },
      { files: ["src/a.ts"], rule: "second rule" },
    ]),
  );

  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /OCR rule: duplicate group path: src\/a\.ts/,
  );
});

test("rule groups reject duplicate membership within a group", async () => {
  const { runOcr } = createFixtureRunner(
    previewWithPaths(["src/a.ts"]),
    validRule([{ files: ["src/a.ts", "src/a.ts"], rule: "review a" }]),
  );

  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /OCR rule: duplicate group path: src\/a\.ts/,
  );
});

test("a nonempty preview rejects empty rule groups", async () => {
  const { runOcr } = createFixtureRunner(
    previewWithPaths(["src/a.ts"]),
    validRule([]),
  );

  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /OCR rule: groups must not be empty for selected paths/,
  );
});

test("rule groups reject an empty files array", async () => {
  const { runOcr } = createFixtureRunner(
    previewWithPaths(["src/a.ts"]),
    validRule([
      { files: ["src/a.ts"], rule: "review a" },
      { files: [], rule: "orphan rule" },
    ]),
  );

  await assert.rejects(
    createOcrAdapter(runOcr).collect("/repo"),
    /OCR rule: groups\[1\]\.files must not be empty/,
  );
});

test("an empty rule string is preserved", async () => {
  const { runOcr } = createFixtureRunner(
    validPreview(),
    JSON.stringify({
      schema_version: "1",
      groups: [{ files: ["src/routes/purchase.ts"], rule: "" }],
    }),
  );

  const input = await createOcrAdapter(runOcr).collect("/repo");

  assert.deepEqual(input.ruleGroups, [
    { files: ["src/routes/purchase.ts"], rules: "" },
  ]);
});
