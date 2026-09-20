import assert from "node:assert/strict";
import test from "node:test";

import {
  executionResultSchema,
  type JsonValue,
  type TestSpec,
} from "@trustgate/contracts";

import {
  runTestSpec,
  type HttpResult,
  type SendRequest,
} from "../src/spec-runner.js";

const validState = (balance = 100, inventoryCount = 0): HttpResult => ({
  status: 200,
  json: { balance, inventoryCount },
});

const assertSchemaValid = (result: unknown): void => {
  assert.doesNotThrow(() => executionResultSchema.parse(result));
};

const responseSpec = (
  assertions: TestSpec["assertions"],
  id = "response-check",
): TestSpec => ({
  id,
  request: { method: "GET", path: "/api/resource" },
  assertions,
});

const sendSequence = (...responses: HttpResult[]): SendRequest => async () => {
  const response = responses.shift();
  assert.ok(response, "unexpected send call");
  return response;
};

test("runner confirms unexpected balance growth", async () => {
  const calls: string[] = [];
  const result = await runTestSpec(
    {
      id: "negative-price",
      request: {
        method: "POST",
        path: "/api/purchase",
        body: { itemId: "sword", price: -100 },
      },
      assertions: [{ kind: "state-delta", key: "balance", equals: 0 }],
    },
    async (path) => {
      calls.push(path);
      if (path === "/__state/alice" && calls.length === 1) {
        return { status: 200, json: { balance: 100, inventoryCount: 0 } };
      }
      if (path === "/__state/alice") {
        return { status: 200, json: { balance: 200, inventoryCount: 1 } };
      }
      return { status: 200, json: { ok: true } };
    },
  );

  assert.equal(result.verdict, "CONFIRMED");
  assert.equal(result.executed, true);
  assert.equal(result.evidence[0]?.actual, 100);
  assertSchemaValid(result);
});

test("runner blocks when every assertion matches", async () => {
  const responses = [
    { status: 200, json: { balance: 100, inventoryCount: 0 } },
    {
      status: 201,
      json: { receipt: { items: [{ id: "sword", tags: ["rare", null] }] } },
    },
    { status: 200, json: { balance: 70, inventoryCount: 1 } },
  ];

  const result = await runTestSpec(
    {
      id: "matching-assertions",
      request: {
        method: "POST",
        path: "/api/purchase",
        body: { itemId: "sword", price: 30 },
      },
      assertions: [
        { kind: "status", equals: 201 },
        {
          kind: "json-equals",
          path: "$.receipt.items.0",
          equals: { tags: ["rare", null], id: "sword" },
        },
        { kind: "state-delta", key: "inventoryCount", equals: 1 },
      ],
    },
    async () => responses.shift()!,
  );

  assert.equal(result.verdict, "BLOCKED");
  assert.equal(result.executed, true);
  assert.deepEqual(result.evidence, []);
  assertSchemaValid(result);
});

test("runner confirms a response status mismatch", async () => {
  const responses: HttpResult[] = [
    validState(),
    { status: 200, json: { ok: true } },
    validState(),
  ];

  const result = await runTestSpec(
    {
      id: "status-mismatch",
      request: { method: "GET", path: "/api/resource" },
      assertions: [{ kind: "status", equals: 403 }],
    },
    async () => responses.shift()!,
  );

  assert.equal(result.verdict, "CONFIRMED");
  assert.deepEqual(result.evidence, [
    { kind: "status", expected: 403, actual: 200 },
  ]);
  assertSchemaValid(result);
});

test("json-equals resolves nested object and numeric array paths", async () => {
  const response: JsonValue = {
    payload: {
      entries: [
        null,
        { metadata: { flags: [true, false], score: 3 } },
      ],
    },
  };
  const result = await runTestSpec(
    responseSpec([
      {
        kind: "json-equals",
        path: "$.payload.entries.1.metadata",
        equals: { score: 3, flags: [true, false] },
      },
    ]),
    sendSequence(validState(), { status: 200, json: response }, validState()),
  );

  assert.equal(result.verdict, "BLOCKED");
  assertSchemaValid(result);
});

test("json-equals confirms a nested structural mismatch", async () => {
  const actual: JsonValue = { flags: [true, null], nested: { value: "actual" } };
  const expected: JsonValue = { nested: { value: "expected" }, flags: [true, null] };
  const result = await runTestSpec(
    responseSpec([
      { kind: "json-equals", path: "$.payload", equals: expected },
    ]),
    sendSequence(
      validState(),
      { status: 200, json: { payload: actual } },
      validState(),
    ),
  );

  assert.equal(result.verdict, "CONFIRMED");
  assert.deepEqual(result.evidence, [
    { kind: "json-equals", expected, actual },
  ]);
  assertSchemaValid(result);
});

test("json-equals treats object key order as irrelevant", async () => {
  const result = await runTestSpec(
    responseSpec([
      {
        kind: "json-equals",
        path: "$",
        equals: { z: null, a: [1, { c: false, b: "value" }] },
      },
    ]),
    sendSequence(
      validState(),
      { status: 200, json: { a: [1, { b: "value", c: false }], z: null } },
      validState(),
    ),
  );

  assert.equal(result.verdict, "BLOCKED");
  assertSchemaValid(result);
});

for (const path of [
  "$.payload.__proto__",
  "$.payload.prototype",
  "$.payload.constructor",
  "$.payload.missing",
]) {
  test(`json-equals rejects unsupported path ${path}`, async () => {
    const responses = [
      validState(),
      { status: 200, json: { payload: { safe: true } } } satisfies HttpResult,
      validState(),
    ];
    let callCount = 0;
    const result = await runTestSpec(
      responseSpec([{ kind: "json-equals", path, equals: null }]),
      async () => {
        callCount += 1;
        return responses.shift()!;
      },
    );

    assert.equal(result.verdict, "ERROR");
    assert.equal(result.executed, false);
    assert.equal(callCount, path.endsWith(".missing") ? 2 : 0);
    assert.deepEqual(result.evidence, [
      {
        kind: "unsupported-json-path",
        expected: "supported-own-json-path",
        actual: "unresolved-json-path",
      },
    ]);
    assertSchemaValid(result);
  });
}

test("json-equals does not traverse inherited properties", async () => {
  const response = Object.create({ payload: { secret: true } }) as JsonValue;
  const result = await runTestSpec(
    responseSpec([
      { kind: "json-equals", path: "$.payload.secret", equals: true },
    ]),
    sendSequence(validState(), { status: 200, json: response }, validState()),
  );

  assert.equal(result.verdict, "ERROR");
  assert.equal(result.executed, false);
  assertSchemaValid(result);
});

for (const invalid of [
  { name: "missing pre-state key", before: { inventoryCount: 0 }, after: { balance: 100, inventoryCount: 0 } },
  { name: "missing post-state key", before: { balance: 100, inventoryCount: 0 }, after: { inventoryCount: 0 } },
  { name: "non-number pre-state value", before: { balance: "100", inventoryCount: 0 }, after: { balance: 100, inventoryCount: 0 } },
  { name: "non-finite post-state value", before: { balance: 100, inventoryCount: 0 }, after: { balance: Number.POSITIVE_INFINITY, inventoryCount: 0 } },
] as const) {
  test(`state-delta returns ERROR for ${invalid.name}`, async () => {
    const result = await runTestSpec(
      responseSpec(
        [{ kind: "state-delta", key: "balance", equals: 0 }],
        "invalid-state",
      ),
      sendSequence(
        { status: 200, json: invalid.before as JsonValue },
        { status: 200, json: { ok: true } },
        { status: 200, json: invalid.after as JsonValue },
      ),
    );

    assert.equal(result.verdict, "ERROR");
    assert.equal(result.executed, false);
    assert.deepEqual(result.evidence, [
      {
        kind: "invalid-state",
        expected: "finite-state-numbers",
        actual: "invalid-state-shape",
      },
    ]);
    assertSchemaValid(result);
  });
}

test("state-delta returns ERROR for a failed state response", async () => {
  const result = await runTestSpec(
    responseSpec(
      [{ kind: "state-delta", key: "balance", equals: 0 }],
      "state-status",
    ),
    sendSequence(
      validState(),
      { status: 200, json: { ok: true } },
      { status: 503, json: { balance: 100, inventoryCount: 0 } },
    ),
  );

  assert.equal(result.verdict, "ERROR");
  assert.equal(result.executed, false);
  assertSchemaValid(result);
});

test("invalid pre-state stops before the test request", async () => {
  let callCount = 0;
  const result = await runTestSpec(
    responseSpec(
      [{ kind: "state-delta", key: "balance", equals: 0 }],
      "early-state-error",
    ),
    async () => {
      callCount += 1;
      return { status: 200, json: { inventoryCount: 0 } };
    },
  );

  assert.equal(callCount, 1);
  assert.equal(result.verdict, "ERROR");
  assert.equal(result.executed, false);
  assertSchemaValid(result);
});

test("every run requires a complete numeric state shape", async () => {
  let callCount = 0;
  const result = await runTestSpec(
    responseSpec([{ kind: "status", equals: 200 }], "complete-state-shape"),
    async () => {
      callCount += 1;
      return { status: 200, json: { balance: 100 } };
    },
  );

  assert.equal(callCount, 1);
  assert.equal(result.verdict, "ERROR");
  assert.equal(result.executed, false);
  assertSchemaValid(result);
});

for (const failureIndex of [0, 1, 2] as const) {
  test(`transport rejection at call ${failureIndex + 1} returns sanitized ERROR`, async () => {
    const secret = "token=super-secret-provider-detail";
    const calls: string[] = [];
    const send: SendRequest = async (path) => {
      calls.push(path);
      if (calls.length - 1 === failureIndex) throw new Error(secret);
      if (path === "/__state/alice") return validState();
      return { status: 200, json: { ok: true } };
    };

    const result = await runTestSpec(
      responseSpec([{ kind: "status", equals: 200 }], `transport-${failureIndex}`),
      send,
    );

    assert.equal(result.verdict, "ERROR");
    assert.equal(result.executed, false);
    assert.equal(calls.length, failureIndex + 1);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.deepEqual(result.evidence, [
      {
        kind: "transport-error",
        expected: "request-completed",
        actual: "request-failed",
      },
    ]);
    assertSchemaValid(result);
  });
}

test("runner uses the fixed actor and exact request order once", async () => {
  const calls: Array<{
    path: string;
    init: Parameters<SendRequest>[1];
  }> = [];
  const responses = [
    validState(),
    { status: 204, json: null },
    validState(),
  ];
  const body: JsonValue = { nested: { value: 7 } };
  const result = await runTestSpec(
    {
      id: "exact-calls",
      request: { method: "PATCH", path: "/api/items/sword", body },
      assertions: [{ kind: "status", equals: 204 }],
    },
    async (path, init) => {
      calls.push({ path, init });
      return responses.shift()!;
    },
  );

  assert.deepEqual(calls, [
    {
      path: "/__state/alice",
      init: { method: "GET", headers: { "x-actor-id": "alice" } },
    },
    {
      path: "/api/items/sword",
      init: {
        method: "PATCH",
        headers: { "x-actor-id": "alice" },
        body,
      },
    },
    {
      path: "/__state/alice",
      init: { method: "GET", headers: { "x-actor-id": "alice" } },
    },
  ]);
  assert.equal(result.verdict, "BLOCKED");
  assertSchemaValid(result);
});

test("runner rejects PUT outside its transport method allowlist", async () => {
  let callCount = 0;
  const result = await runTestSpec(
    {
      id: "put-request",
      request: { method: "PUT", path: "/api/items/sword", body: null },
      assertions: [{ kind: "status", equals: 200 }],
    },
    async () => {
      callCount += 1;
      return validState();
    },
  );

  assert.equal(callCount, 0);
  assert.equal(result.verdict, "ERROR");
  assert.equal(result.executed, false);
  assert.deepEqual(result.evidence, [
    {
      kind: "unsupported-method",
      expected: "GET-POST-PATCH-DELETE",
      actual: "unsupported-method",
    },
  ]);
  assertSchemaValid(result);
});

test("runner does not mutate the spec or response objects", async () => {
  const spec = {
    id: "immutable-inputs",
    request: {
      method: "POST" as const,
      path: "/api/resource",
      body: { values: [1, null, { safe: true }] },
    },
    assertions: [
      { kind: "json-equals" as const, path: "$.data", equals: { ok: true } },
      { kind: "state-delta" as const, key: "balance" as const, equals: 0 },
    ],
  } satisfies TestSpec;
  const before = validState();
  const response: HttpResult = { status: 200, json: { data: { ok: true } } };
  const after = validState();
  const specSnapshot = structuredClone(spec);
  const responseSnapshots = structuredClone([before, response, after]);

  const result = await runTestSpec(
    spec,
    sendSequence(before, response, after),
  );

  assert.deepEqual(spec, specSnapshot);
  assert.deepEqual([before, response, after], responseSnapshots);
  assert.equal(result.verdict, "BLOCKED");
  assertSchemaValid(result);
});

test("runner produces a deterministic bounded identity", async () => {
  const spec = responseSpec([{ kind: "status", equals: 200 }], "stable-run-id");
  const first = await runTestSpec(
    spec,
    sendSequence(validState(), { status: 200, json: null }, validState()),
  );
  const second = await runTestSpec(
    spec,
    sendSequence(validState(), { status: 200, json: null }, validState()),
  );

  assert.equal(first.runId, second.runId);
  assert.ok(first.runId.length <= 128);
  assert.equal(first.hypothesisId, spec.id);
  assertSchemaValid(first);
  assertSchemaValid(second);
});

test("runner rejects a contract-supported but executor-unsupported state key", async () => {
  let callCount = 0;
  const result = await runTestSpec(
    responseSpec(
      [{ kind: "state-delta", key: "ownerId", equals: null }],
      "unsupported-state-key",
    ),
    async () => {
      callCount += 1;
      return validState();
    },
  );

  assert.equal(result.verdict, "ERROR");
  assert.equal(result.executed, false);
  assert.equal(callCount, 0);
  assert.deepEqual(result.evidence, [
    {
      kind: "unsupported-state-key",
      expected: "balance-or-inventoryCount",
      actual: "unsupported-state-key",
    },
  ]);
  assertSchemaValid(result);
});
