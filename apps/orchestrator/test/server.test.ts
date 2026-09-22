import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AnalysisPlan, ExecutionResult } from "@trustgate/contracts";

import { createRunReport, type RunReport } from "../src/report.js";
import {
  buildServer,
  type RunLogRecord,
  type WorkspacePipeline,
  type WorkspacePipelineFactory,
} from "../src/server.js";

test("fixture analysis returns a fixed regression report", async () => {
  const app = buildServer({ mode: "fixture" });
  const response = await app.inject({ method: "POST", url: "/api/runs", payload: { source: "fixture" } });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().hypotheses[0].regressionVerdict, "FIXED");
  await app.close();
});

const REVIEWED_FILE = "src/store.ts";
const PROVIDER = "test-provider";
const MODEL = "test-model";

const plan: AnalysisPlan = {
  version: 1,
  hypotheses: [
    {
      id: "price-authority",
      title: "Server controls item prices",
      category: "price-tampering",
      severity: "high",
      evidence: [{ file: REVIEWED_FILE, line: 1, excerpt: "price = request.price" }],
      tests: [
        {
          id: "negative-price",
          request: {
            method: "POST",
            path: "/api/purchase",
            body: { itemId: "sword", price: -100 },
          },
          assertions: [{ kind: "status", equals: 400 }],
        },
      ],
    },
  ],
};

const confirmed: ExecutionResult = {
  runId: "spec-negative-price",
  hypothesisId: "price-authority",
  verdict: "CONFIRMED",
  executed: true,
  evidence: [{ kind: "status", expected: 400, actual: 200 }],
};

const blocked: ExecutionResult = { ...confirmed, verdict: "BLOCKED", evidence: [] };

const makeReport = (runId: string): RunReport =>
  createRunReport({
    runId,
    provider: PROVIDER,
    model: MODEL,
    reviewedFiles: [REVIEWED_FILE],
    hypotheses: plan.hypotheses,
    vulnerableResults: [confirmed],
    patchedResults: [blocked],
    durations: {
      totalMs: 5,
      ocrMs: 1,
      planningMs: 1,
      vulnerableMs: 1,
      patchedMs: 1,
    },
  });

type Deferred = { promise: Promise<void>; resolve: () => void };

const createDeferred = (): Deferred => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const withTimeout = async <Value>(
  promise: Promise<Value>,
  label: string,
): Promise<Value> =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), 10_000).unref();
    }),
  ]);

const fakeSecret = (...parts: string[]): string => parts.join("");

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/,
  /\b(?:gh[opsur]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:authorization|bearer|api[-_]?key|token|password|secret)\b\s*[:=]\s*\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\braw[-_ ]?(?:prompt|error)\b/i,
];

const LOG_RECORD_KEYS = new Set([
  "event",
  "method",
  "route",
  "statusCode",
  "durationMs",
  "runId",
  "source",
  "reason",
]);

const assertClean = (text: string, label: string, absolutes: readonly string[]): void => {
  for (const pattern of SECRET_PATTERNS) {
    assert.ok(!pattern.test(text), `${label} leaked a secret-like value: ${pattern}`);
  }
  for (const absolute of absolutes) {
    assert.ok(!text.includes(absolute), `${label} leaked an absolute host path`);
  }
  assert.ok(!text.includes("sk-"), `${label} leaked a key prefix`);
};

const createPipeline = (
  overrides: Partial<WorkspacePipeline> = {},
): WorkspacePipeline => ({
  provider: PROVIDER,
  model: MODEL,
  review: async () => ({
    mode: "workspace",
    files: [
      { path: REVIEWED_FILE, status: "modified", additions: 2, deletions: 1 },
    ],
    ruleGroups: [],
  }),
  diffs: async () => [{ path: REVIEWED_FILE, diff: "@@ -1 +1 @@", truncated: false }],
  plan: async () => plan,
  sandbox: async (mode) => [mode === "vulnerable" ? confirmed : blocked],
  ...overrides,
});

test("health endpoint reports ok", async () => {
  const app = buildServer({ mode: "fixture" });
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  await app.close();
});

test("fixture run reports RunReport fields at the top level with its source", async () => {
  const app = buildServer({ mode: "fixture" });
  const response = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { source: "fixture" },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), [
    "durations",
    "hypotheses",
    "model",
    "patchedResults",
    "provider",
    "regressionVerdict",
    "reviewedFiles",
    "runId",
    "source",
    "vulnerableResults",
  ]);
  assert.equal(body.source, "fixture");
  assert.equal(body.regressionVerdict, "FIXED");
  assert.match(body.runId, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/);
  assert.equal(body.hypotheses[0].tests[0].vulnerableResult.verdict, "CONFIRMED");
  assert.equal(body.hypotheses[0].tests[0].patchedResult.verdict, "BLOCKED");
  assert.ok(
    body.hypotheses.every(
      (hypothesis: { regressionVerdict: string }) =>
        hypothesis.regressionVerdict === "FIXED",
    ),
  );
  assertClean(response.body, "fixture response", [process.cwd()]);
  await app.close();
});

test("fixture mode is deterministic and never builds the workspace pipeline", async () => {
  let pipelineBuilt = 0;
  const createWorkspacePipeline: WorkspacePipelineFactory = () => {
    pipelineBuilt += 1;
    throw new Error("workspace pipeline must not be built in fixture mode");
  };
  const app = buildServer({ mode: "fixture", createWorkspacePipeline });

  const first = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { source: "fixture" },
  });
  const second = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { source: "fixture" },
  });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.equal(pipelineBuilt, 0);
  const firstBody = first.json();
  const secondBody = second.json();
  assert.notEqual(firstBody.runId, secondBody.runId);
  assert.deepEqual(
    { ...firstBody, runId: "normalized" },
    { ...secondBody, runId: "normalized" },
  );
  await app.close();
});

test("stored runs are readable by runId and unknown ids are 404", async () => {
  const app = buildServer({ mode: "fixture" });
  const created = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { source: "fixture" },
  });
  assert.equal(created.statusCode, 201);
  const runId = created.json().runId as string;

  const stored = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
  assert.equal(stored.statusCode, 200);
  assert.deepEqual(stored.json(), created.json());

  const missing = await app.inject({
    method: "GET",
    url: "/api/runs/run-does-not-exist",
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: "run not found" });

  const tooLong = await app.inject({
    method: "GET",
    url: `/api/runs/${"x".repeat(120)}`,
  });
  assert.equal(tooLong.statusCode, 404);

  const malformed = await app.inject({
    method: "GET",
    url: "/api/runs/run%20bad",
  });
  assert.equal(malformed.statusCode, 404);

  const oversized = await app.inject({
    method: "GET",
    url: `/api/runs/${"x".repeat(300)}`,
  });
  assert.equal(oversized.statusCode, 400);
  assert.deepEqual(oversized.json(), { error: "invalid request" });
  assert.ok(!oversized.body.includes("xxx"), "oversized param was echoed");

  const otherServer = buildServer({ mode: "fixture" });
  const leaked = await otherServer.inject({ method: "GET", url: `/api/runs/${runId}` });
  assert.equal(leaked.statusCode, 404);
  await otherServer.close();
  await app.close();
});

test("invalid request bodies are rejected with 400", async () => {
  const app = buildServer({ mode: "workspace" });
  const secret = fakeSecret("sk-", "A".repeat(24));
  const cases: Array<{ name: string; payload: unknown; contentType?: string }> = [
    { name: "missing source", payload: {} },
    { name: "unknown key", payload: { source: "fixture", apiKey: secret } },
    { name: "unknown nested key", payload: { source: "fixture", options: {} } },
    { name: "wrong source type", payload: { source: 7 } },
    { name: "unknown source", payload: { source: "remote" } },
    { name: "array body", payload: [{ source: "fixture" }] },
    { name: "null body", payload: null },
    { name: "string body", payload: `{"apiKey":"${secret}"}` },
    { name: "malformed json", payload: "{not json", contentType: "application/json" },
    { name: "repoPath type", payload: { source: "workspace", repoPath: 5 } },
    { name: "repoPath empty", payload: { source: "workspace", repoPath: "" } },
    {
      name: "providerId characters",
      payload: { source: "fixture", providerId: `bad id ${secret}` },
    },
    {
      name: "providerId type",
      payload: { source: "fixture", providerId: { id: PROVIDER } },
    },
  ];

  for (const item of cases) {
    const response = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: item.payload as never,
      ...(item.contentType === undefined
        ? {}
        : { headers: { "content-type": item.contentType } }),
    });
    assert.equal(response.statusCode, 400, `expected 400 for ${item.name}`);
    assert.deepEqual(response.json(), { error: "invalid request" }, item.name);
    assert.ok(!response.body.includes(secret), `${item.name} echoed the secret`);
  }

  const noBody = await app.inject({ method: "POST", url: "/api/runs" });
  assert.equal(noBody.statusCode, 400);
  await app.close();
});

test("fixture mode refuses workspace requests", async () => {
  const app = buildServer({ mode: "fixture" });
  const response = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { source: "workspace" },
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "invalid request" });
  await app.close();
});

test("workspace runs normalize the repository path and reject escapes", async () => {
  const scratch = process.env.TMPDIR ?? tmpdir();
  const root = await mkdtemp(join(scratch, "trustgate-server-root-"));
  const outside = await mkdtemp(join(scratch, "trustgate-server-outside-"));
  const app = buildServer({
    mode: "workspace",
    rootDir: root,
    executeRun: async (task) => makeReport(task.runId),
  });
  const repoPaths = new Set<string>();
  const recordingApp = buildServer({
    mode: "workspace",
    rootDir: root,
    createWorkspacePipeline: (_task) => {
      const pipeline = createPipeline();
      return {
        ...pipeline,
        review: async (repoPath) => {
          repoPaths.add(repoPath);
          return pipeline.review(repoPath);
        },
      };
    },
  });
  try {
    await mkdir(join(root, "apps", "demo-target"), { recursive: true });
    await writeFile(join(root, "README.md"), "trustgate\n", "utf8");
    await symlink(outside, join(root, "escape-link"));

    // Allowed: an allowlisted subdirectory is resolved to its real path.
    const allowed = await recordingApp.inject({
      method: "POST",
      url: "/api/runs",
      payload: { source: "workspace", repoPath: "apps/demo-target" },
    });
    assert.equal(allowed.statusCode, 201);
    assert.equal(allowed.json().source, "workspace");
    assert.equal(repoPaths.size, 1);
    assert.ok(repoPaths.has(join(root, "apps", "demo-target")));
    assertClean(allowed.body, "workspace response", [root, outside]);

    // Allowed: omitting repoPath analyzes the allowlist root itself.
    const defaultRoot = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { source: "workspace" },
    });
    assert.equal(defaultRoot.statusCode, 201);

    const rejected = [
      "../outside",
      "apps/../../outside",
      join("apps", "..", "..", "outside"),
      outside,
      root,
      "/etc",
      "/",
      "escape-link",
      "README.md",
      "missing-directory",
      "apps//demo-target",
      "./apps/demo-target",
    ];

    for (const repoPath of rejected) {
      const response = await app.inject({
        method: "POST",
        url: "/api/runs",
        payload: { source: "workspace", repoPath },
      });
      assert.equal(response.statusCode, 400, `expected 400 for ${repoPath}`);
      assert.deepEqual(response.json(), { error: "invalid repository path" });
      assert.ok(!response.body.includes(root), `${repoPath} echoed the root`);
      assert.ok(
        !response.body.includes(outside),
        `${repoPath} echoed the escaping path`,
      );
    }
  } finally {
    await app.close();
    await recordingApp.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("workspace runs execute OCR, diffs, planner, sandbox, then report", async () => {
  const scratch = process.env.TMPDIR ?? tmpdir();
  const root = await mkdtemp(join(scratch, "trustgate-server-order-"));
  const order: string[] = [];
  const app = buildServer({
    mode: "workspace",
    rootDir: root,
    createWorkspacePipeline: () => {
      const pipeline = createPipeline();
      return {
        ...pipeline,
        review: async (repoPath) => {
          order.push("ocr");
          return pipeline.review(repoPath);
        },
        diffs: async (repoPath, review) => {
          order.push("diffs");
          return pipeline.diffs(repoPath, review);
        },
        plan: async (input) => {
          order.push("planner");
          return pipeline.plan(input);
        },
        sandbox: async (mode, sandboxPlan) => {
          order.push(`sandbox:${mode}`);
          return pipeline.sandbox(mode, sandboxPlan);
        },
      };
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { source: "workspace", providerId: "locked-provider" },
    });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(order, [
      "ocr",
      "diffs",
      "planner",
      "sandbox:vulnerable",
      "sandbox:patched",
    ]);
    const body = response.json();
    assert.equal(body.source, "workspace");
    assert.equal(body.provider, PROVIDER);
    assert.equal(body.hypotheses[0].regressionVerdict, "FIXED");
    assert.equal(body.regressionVerdict, "FIXED");
    assert.deepEqual(body.reviewedFiles, [REVIEWED_FILE]);
    assert.deepEqual(Object.keys(body.durations).sort(), [
      "ocrMs",
      "patchedMs",
      "planningMs",
      "totalMs",
      "vulnerableMs",
    ]);
    for (const duration of Object.values<number>(body.durations)) {
      assert.ok(Number.isSafeInteger(duration) && duration >= 0);
    }
    assertClean(response.body, "workspace pipeline response", [root]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a second concurrent run is rejected with 409 and the gate reopens", async () => {
  const started = createDeferred();
  const release = createDeferred();
  const runIds: string[] = [];
  const app = buildServer({
    mode: "fixture",
    executeRun: async (task) => {
      runIds.push(task.runId);
      started.resolve();
      await release.promise;
      return makeReport(task.runId);
    },
  });

  const first = app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { source: "fixture" },
  });
  await withTimeout(started.promise, "in-flight run");

  const second = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { source: "fixture" },
  });
  assert.equal(second.statusCode, 409);
  assert.deepEqual(second.json(), { error: "run already in progress" });

  release.resolve();
  const firstResponse = await first;
  assert.equal(firstResponse.statusCode, 201);
  assert.equal(runIds.length, 1);

  const third = await app.inject({
    method: "POST",
    url: "/api/runs",
    payload: { source: "fixture" },
  });
  assert.equal(third.statusCode, 201);
  assert.equal(runIds.length, 2);
  await app.close();
});

test("workspace runtime failures stay generic and unavailable ones are 503", async () => {
  const scratch = process.env.TMPDIR ?? tmpdir();
  const root = await mkdtemp(join(scratch, "trustgate-server-failure-"));
  const secret = fakeSecret("sk-", "B".repeat(24));
  const failing = buildServer({
    mode: "workspace",
    rootDir: root,
    executeRun: async () => {
      throw new Error(`upstream said api_key=${secret}`);
    },
  });
  const unavailable = buildServer({ mode: "workspace", rootDir: root });
  try {
    const failure = await failing.inject({
      method: "POST",
      url: "/api/runs",
      payload: { source: "workspace" },
    });
    assert.equal(failure.statusCode, 500);
    assert.deepEqual(failure.json(), { error: "run failed" });
    assert.ok(!failure.body.includes(secret));

    const missingConfig = await unavailable.inject({
      method: "POST",
      url: "/api/runs",
      payload: { source: "workspace" },
    });
    assert.equal(missingConfig.statusCode, 503);
    assert.deepEqual(missingConfig.json(), {
      error: "workspace analysis unavailable",
    });
  } finally {
    await failing.close();
    await unavailable.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("logs and responses never carry secrets, prompts, or host paths", async () => {
  const scratch = process.env.TMPDIR ?? tmpdir();
  const root = await mkdtemp(join(scratch, "trustgate-server-logs-"));
  const records: RunLogRecord[] = [];
  const secret = fakeSecret("ghp_", "C".repeat(24));
  const secretPath = join(root, "secret-project");
  await mkdir(secretPath, { recursive: true });

  const app = buildServer({
    mode: "workspace",
    rootDir: root,
    log: (record) => records.push(record),
    createWorkspacePipeline: () => {
      const pipeline = createPipeline();
      return {
        ...pipeline,
        sandbox: async () => {
          throw new Error(`provider replied with token=${secret}`);
        },
      };
    },
  });

  const responses: string[] = [];
  try {
    const ok = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { source: "fixture" },
    });
    responses.push(ok.body);

    const badBody = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { source: "fixture", authorization: secret, prompt: "system prompt" },
    });
    responses.push(badBody.body);

    const traversal = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { source: "workspace", repoPath: secretPath },
    });
    responses.push(traversal.body);

    const failed = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { source: "workspace" },
    });
    responses.push(failed.body);

    const unknown = await app.inject({
      method: "GET",
      url: `/api/runs/${secret}`,
    });
    responses.push(unknown.body);

    assert.equal(traversal.statusCode, 400);
    assert.equal(failed.statusCode, 500);
    assert.equal(unknown.statusCode, 404);

    const logText = JSON.stringify(records);
    assert.ok(logText.length > 0);
    for (const response of responses) {
      assertClean(response, "response", [root, secretPath, process.cwd()]);
      assert.ok(!response.includes(secret));
    }
    assertClean(logText, "logs", [root, secretPath, process.cwd()]);
    assert.ok(!logText.includes(secret));
    assert.ok(!logText.includes("authorization"));
    assert.ok(!logText.includes("prompt"));

    for (const record of records) {
      for (const key of Object.keys(record)) {
        assert.ok(LOG_RECORD_KEYS.has(key), `unexpected log field ${key}`);
      }
    }
    assert.deepEqual(
      records.filter((record) => record.event === "run.rejected").map(
        (record) => (record.event === "run.rejected" ? record.reason : ""),
      ),
      ["invalid_request", "invalid_repo_path", "run_failed"],
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
