import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_JSON_MAX_BYTES,
  type AnalysisPlan,
  type TestSpec,
} from "@trustgate/contracts";

import { buildServer } from "../src/server.js";
import {
  FETCH_TIMEOUT_MS,
  createLoopbackSendRequest,
  executeAnalysisPlan,
  parseTargetMode,
  readBoundedStdin,
  runSandboxMain,
} from "../src/sandbox-main.js";

const testSpec = (id: string, assertions: TestSpec["assertions"]): TestSpec => ({
  id,
  request: {
    method: "POST",
    path: "/api/purchase",
    body: { itemId: "sword", price: -100 },
  },
  assertions,
});

const planWith = (...tests: TestSpec[]): AnalysisPlan => ({
  version: 1,
  hypotheses: [
    {
      id: "price-authority",
      title: "Server controls item prices",
      category: "price-tampering",
      severity: "high",
      evidence: [{ file: "src/store.ts", line: 1, excerpt: "price" }],
      tests,
    },
  ],
});

const negativePricePlan = planWith(
  testSpec("negative-price", [
    { kind: "status", equals: 400 },
    { kind: "state-delta", key: "balance", equals: 0 },
  ]),
);

const chunks = (...values: Array<string | Uint8Array>): AsyncIterable<string | Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield* values;
  },
});

test("target mode accepts only exact vulnerable and patched values", () => {
  assert.equal(parseTargetMode("vulnerable"), "vulnerable");
  assert.equal(parseTargetMode("patched"), "patched");
  for (const invalid of [undefined, "", "VULNERABLE", "patched ", "production"]) {
    assert.throws(() => parseTargetMode(invalid), /invalid sandbox mode/);
  }
});

test("bounded stdin accepts the exact byte limit and rejects one byte more", async () => {
  const exact = "x".repeat(CONTRACT_JSON_MAX_BYTES);
  assert.equal(await readBoundedStdin(chunks(exact)), exact);
  await assert.rejects(
    readBoundedStdin(chunks("x".repeat(CONTRACT_JSON_MAX_BYTES), "x")),
    /sandbox input rejected/,
  );
});

test("bounded stdin rejects malformed UTF-8", async () => {
  await assert.rejects(
    readBoundedStdin(chunks(Uint8Array.from([0xc3, 0x28]))),
    /sandbox input rejected/,
  );
});

test("sandbox executes real loopback HTTP and overwrites identity deterministically", async () => {
  const vulnerable = await executeAnalysisPlan(negativePricePlan, "vulnerable");
  const patched = await executeAnalysisPlan(negativePricePlan, "patched");

  assert.equal(vulnerable.length, 1);
  assert.deepEqual(
    {
      runId: vulnerable[0]!.runId,
      hypothesisId: vulnerable[0]!.hypothesisId,
      verdict: vulnerable[0]!.verdict,
      executed: vulnerable[0]!.executed,
      evidenceNonempty: vulnerable[0]!.evidence.length > 0,
    },
    {
      runId: "spec-negative-price",
      hypothesisId: "price-authority",
      verdict: "CONFIRMED",
      executed: true,
      evidenceNonempty: true,
    },
  );
  assert.deepEqual(patched, [
    {
      runId: "spec-negative-price",
      hypothesisId: "price-authority",
      verdict: "BLOCKED",
      executed: true,
      evidence: [],
    },
  ]);
});

test("tests run in plan order with a fresh server and store per spec", async () => {
  const freshStatePlan = planWith(
    {
      id: "first-purchase",
      request: {
        method: "POST",
        path: "/api/purchase",
        body: { itemId: "sword", price: 30 },
      },
      assertions: [{ kind: "state-delta", key: "inventoryCount", equals: 1 }],
    },
    {
      id: "second-purchase",
      request: {
        method: "POST",
        path: "/api/purchase",
        body: { itemId: "sword", price: 30 },
      },
      assertions: [{ kind: "state-delta", key: "inventoryCount", equals: 1 }],
    },
  );
  let serverCount = 0;

  const results = await executeAnalysisPlan(freshStatePlan, "vulnerable", {
    buildServer(mode) {
      serverCount += 1;
      return buildServer(mode);
    },
  });

  assert.equal(serverCount, 2);
  assert.deepEqual(
    results.map(({ runId, hypothesisId, verdict }) => ({ runId, hypothesisId, verdict })),
    [
      { runId: "spec-first-purchase", hypothesisId: "price-authority", verdict: "BLOCKED" },
      { runId: "spec-second-purchase", hypothesisId: "price-authority", verdict: "BLOCKED" },
    ],
  );
});

test("duplicate test IDs are rejected globally before any server starts", async () => {
  const duplicatePlan: AnalysisPlan = {
    ...negativePricePlan,
    hypotheses: [
      negativePricePlan.hypotheses[0]!,
      {
        ...negativePricePlan.hypotheses[0]!,
        id: "other-hypothesis",
        tests: [testSpec("negative-price", [{ kind: "status", equals: 400 }])],
      },
    ],
  };
  let serverCount = 0;

  await assert.rejects(
    executeAnalysisPlan(duplicatePlan, "patched", {
      buildServer(mode) {
        serverCount += 1;
        return buildServer(mode);
      },
    }),
    /duplicate test identity/,
  );
  assert.equal(serverCount, 0);
});

test("each server is closed even when test execution throws", async () => {
  let closeCalls = 0;
  await assert.rejects(
    executeAnalysisPlan(negativePricePlan, "patched", {
      buildServer(mode) {
        const app = buildServer(mode);
        app.addHook("onClose", async () => {
          closeCalls += 1;
        });
        return app;
      },
      async runTestSpec() {
        throw new Error("infrastructure marker");
      },
    }),
    /infrastructure marker/,
  );
  assert.equal(closeCalls, 1);
});

test("a listen failure still closes the fresh server", async () => {
  let closeCalls = 0;
  const blocker = buildServer("patched");
  const address = await blocker.listen({ host: "127.0.0.1", port: 0 });
  const port = Number(new URL(address).port);

  try {
    await assert.rejects(
      executeAnalysisPlan(negativePricePlan, "patched", {
        buildServer(mode) {
          const app = buildServer(mode);
          app.addHook("onClose", async () => {
            closeCalls += 1;
          });
          const listen = app.listen.bind(app);
          app.listen = ((options: Parameters<typeof app.listen>[0]) =>
            listen({ ...options, port })) as typeof app.listen;
          return app;
        },
      }),
    );
    assert.equal(closeCalls, 1);
  } finally {
    await blocker.close();
  }
});

test("loopback adapter sends bounded JSON with fixed request policy", async () => {
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    observedUrl = String(input);
    observedInit = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  const send = createLoopbackSendRequest("http://127.0.0.1:43210", fakeFetch);

  const result = await send("/api/purchase", {
    method: "POST",
    headers: { "x-actor-id": "alice", "content-type": "text/plain" },
    body: { price: 30, itemId: "sword" },
  });

  assert.deepEqual(result, { status: 201, json: { ok: true } });
  assert.equal(observedUrl, "http://127.0.0.1:43210/api/purchase");
  assert.equal(observedInit?.method, "POST");
  assert.equal(observedInit?.redirect, "error");
  assert.equal(observedInit?.body, JSON.stringify({ price: 30, itemId: "sword" }));
  assert.deepEqual(observedInit?.headers, {
    "x-actor-id": "alice",
    "content-type": "application/json",
  });
  assert.ok(observedInit?.signal instanceof AbortSignal);
  assert.equal(FETCH_TIMEOUT_MS, 5_000);
});

test("loopback adapter omits content type and body for bodyless requests", async () => {
  let observedInit: RequestInit | undefined;
  const send = createLoopbackSendRequest(
    "http://127.0.0.1:43210",
    (async (_input, init) => {
      observedInit = init;
      return new Response("null", { status: 200 });
    }) as typeof fetch,
  );

  await send("/__state/alice", {
    method: "GET",
    headers: { "x-actor-id": "alice", "content-type": "application/json" },
  });

  assert.deepEqual(observedInit?.headers, { "x-actor-id": "alice" });
  assert.equal(observedInit?.body, undefined);
});

test("loopback adapter maps an empty HTTP response body to JSON null", async () => {
  const send = createLoopbackSendRequest(
    "http://127.0.0.1:43210",
    (async () => new Response(null, { status: 204 })) as typeof fetch,
  );

  assert.deepEqual(
    await send("/api/resource", { method: "DELETE", headers: {} }),
    { status: 204, json: null },
  );
});

test("loopback adapter rejects cross-origin paths before fetch", async () => {
  let calls = 0;
  const send = createLoopbackSendRequest(
    "http://127.0.0.1:43210",
    (async () => {
      calls += 1;
      return new Response("null");
    }) as typeof fetch,
  );

  await assert.rejects(
    send("//attacker.invalid/path", { method: "GET", headers: {} }),
    /invalid loopback path/,
  );
  await assert.rejects(
    send("http://attacker.invalid/path", { method: "GET", headers: {} }),
    /invalid loopback path/,
  );
  assert.equal(calls, 0);
});

test("loopback adapter rejects oversized, malformed, and non-JSON-origin responses", async () => {
  for (const body of [
    "x".repeat(CONTRACT_JSON_MAX_BYTES + 1),
    "not-json",
    JSON.stringify({ value: Number.NaN }).replace("null", "NaN"),
  ]) {
    const send = createLoopbackSendRequest(
      "http://127.0.0.1:43210",
      (async () => new Response(body, { status: 200 })) as typeof fetch,
    );
    await assert.rejects(
      send("/api/purchase", { method: "GET", headers: {} }),
    );
  }
});

test("main emits exactly one JSON array line and no stderr on success", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runSandboxMain({
    stdin: chunks(JSON.stringify(negativePricePlan)),
    targetMode: "patched",
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.length, 1);
  assert.equal(stdout[0], `${JSON.stringify(await executeAnalysisPlan(negativePricePlan, "patched"))}\n`);
  assert.deepEqual(stderr, []);
});

test("main fails generically for malformed, oversized, schema-invalid input and invalid mode", async () => {
  const secret = "do-not-echo-this-plan";
  const cases = [
    { input: `{${secret}`, mode: "patched" },
    { input: "x".repeat(CONTRACT_JSON_MAX_BYTES + 1), mode: "patched" },
    { input: JSON.stringify({ version: 1, hypotheses: [] }), mode: "patched" },
    { input: JSON.stringify(negativePricePlan), mode: "PATCHED" },
  ];

  for (const item of cases) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runSandboxMain({
      stdin: chunks(item.input),
      targetMode: item.mode,
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, ["sandbox execution failed\n"]);
    assert.doesNotMatch(stderr.join(""), new RegExp(secret));
    assert.ok(Buffer.byteLength(stderr.join(""), "utf8") < 128);
  }
});
