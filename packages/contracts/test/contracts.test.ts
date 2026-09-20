import assert from "node:assert/strict";
import test from "node:test";

import * as contracts from "../src/index.js";

const {
  analysisPlanSchema,
  executionResultSchema,
  JSON_MAX_ARRAY_LENGTH,
  JSON_MAX_DEPTH,
  JSON_MAX_RECORD_KEYS,
  JSON_MAX_STRING_LENGTH,
  jsonValueSchema,
  requestSchema,
} = contracts;

const validPlan = {
  version: 1,
  hypotheses: [{
    id: "price-authority",
    title: "클라이언트 가격 신뢰",
    category: "price-tampering",
    severity: "high",
    evidence: [{ file: "src/routes/purchase.ts", line: 18, excerpt: "price: body.price" }],
    tests: [{
      id: "negative-price",
      request: { method: "POST", path: "/api/purchase", body: { itemId: "sword", price: -100 } },
      assertions: [
        { kind: "status", equals: 400 },
        { kind: "state-delta", key: "balance", equals: 0 },
      ],
    }],
  }],
};

const validHypothesis = validPlan.hypotheses[0]!;
const validTest = validHypothesis.tests[0]!;
const validEvidence = { kind: "status", expected: 400, actual: 400 };

function planWithTest(testSpec: unknown) {
  return {
    ...validPlan,
    hypotheses: [{
      ...validHypothesis,
      tests: [testSpec],
    }],
  };
}

function nestedArray(depth: number): unknown {
  let value: unknown = "leaf";
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

function recordWithKeys(count: number): Record<string, true> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`key-${index}`, true] as const),
  );
}

function getParseContractJson(): (schema: typeof analysisPlanSchema, text: string) => unknown {
  const candidate: unknown = Reflect.get(contracts, "parseContractJson");
  assert.equal(typeof candidate, "function", "parseContractJson must be exported");
  return candidate as (schema: typeof analysisPlanSchema, text: string) => unknown;
}

function assertThrowsNamed(
  operation: () => unknown,
  expectedName: "RangeError" | "SyntaxError",
  message: string,
) {
  assert.throws(operation, (error: unknown) => {
    assert.equal(error instanceof Error ? error.name : undefined, expectedName, message);
    return true;
  });
}

test("analysis plan accepts the bounded DSL", () => {
  assert.equal(analysisPlanSchema.parse(validPlan).hypotheses[0]?.tests[0]?.id, "negative-price");

  const jsonOriginRequest = JSON.parse(JSON.stringify(validTest.request)) as unknown;
  const compositionFailures: string[] = [];
  const publicCompositions = [
    ["refine", requestSchema.refine(() => true), jsonOriginRequest],
    ["clone", requestSchema.clone(), jsonOriginRequest],
    ["describe", requestSchema.describe("request contract"), jsonOriginRequest],
    ["meta", requestSchema.meta({ contract: "request" }), jsonOriginRequest],
  ] as const;

  for (const [name, schema, input] of publicCompositions) {
    try {
      schema.parse(input);
    } catch (error) {
      compositionFailures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const parseCandidate: unknown = Reflect.get(contracts, "parseContractJson");
  if (typeof parseCandidate !== "function") {
    compositionFailures.push("parseContractJson: export is missing");
  } else {
    try {
      const parsed = parseCandidate(analysisPlanSchema, JSON.stringify(validPlan)) as typeof validPlan;
      assert.equal(parsed.hypotheses[0]?.tests[0]?.id, "negative-price");
    } catch (error) {
      compositionFailures.push(
        `parseContractJson: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  assert.deepEqual(compositionFailures, [], "public Zod composition and JSON ingress must work");

  const nestedBodyPlan = planWithTest({
    ...validTest,
    request: {
      ...validTest.request,
      body: {
        player: {
          inventory: [
            { itemId: "sword", stats: { durability: 100, equipped: true } },
          ],
        },
      },
    },
  });
  assert.equal(analysisPlanSchema.safeParse(nestedBodyPlan).success, true);

  assert.equal(
    jsonValueSchema.safeParse(nestedArray(JSON_MAX_DEPTH)).success,
    true,
    "JSON at depth 8 must be accepted",
  );
  assert.equal(
    jsonValueSchema.safeParse(nestedArray(JSON_MAX_DEPTH + 1)).success,
    false,
    "JSON at depth 9 must be rejected",
  );
  assert.equal(
    jsonValueSchema.safeParse(Array.from({ length: JSON_MAX_ARRAY_LENGTH }, () => true)).success,
    true,
    "64 JSON array items must be accepted",
  );
  assert.equal(
    jsonValueSchema.safeParse(Array.from({ length: JSON_MAX_ARRAY_LENGTH + 1 }, () => true)).success,
    false,
    "65 JSON array items must be rejected",
  );
  assert.equal(
    jsonValueSchema.safeParse(recordWithKeys(JSON_MAX_RECORD_KEYS)).success,
    true,
    "64 JSON record keys must be accepted",
  );
  assert.equal(
    jsonValueSchema.safeParse(recordWithKeys(JSON_MAX_RECORD_KEYS + 1)).success,
    false,
    "65 JSON record keys must be rejected",
  );
  assert.equal(
    jsonValueSchema.safeParse("x".repeat(JSON_MAX_STRING_LENGTH)).success,
    true,
    "16,384-character JSON strings must be accepted",
  );
  assert.equal(
    jsonValueSchema.safeParse("x".repeat(JSON_MAX_STRING_LENGTH + 1)).success,
    false,
    "16,385-character JSON strings must be rejected",
  );
  assert.equal(
    jsonValueSchema.safeParse({ ["k".repeat(256)]: true }).success,
    true,
    "256-character JSON record keys must be accepted",
  );
  assert.equal(
    jsonValueSchema.safeParse({ ["k".repeat(257)]: true }).success,
    false,
    "257-character JSON record keys must be rejected",
  );
  assert.equal(jsonValueSchema.safeParse(Number.POSITIVE_INFINITY).success, false);

  assert.equal(
    analysisPlanSchema.safeParse({
      ...validPlan,
      hypotheses: Array.from({ length: 10 }, (_, index) => ({
        ...validHypothesis,
        id: `hypothesis-${index}`,
      })),
    }).success,
    true,
    "10 hypotheses must be accepted",
  );
  assert.equal(
    analysisPlanSchema.safeParse({
      ...validPlan,
      hypotheses: Array.from({ length: 11 }, (_, index) => ({
        ...validHypothesis,
        id: `hypothesis-${index}`,
      })),
    }).success,
    false,
    "11 hypotheses must be rejected",
  );
  assert.equal(
    analysisPlanSchema.safeParse({ ...validPlan, hypotheses: [] }).success,
    false,
    "an empty hypothesis list must be rejected",
  );

  const evidenceAtLimit = Array.from(
    { length: 8 },
    (_, index) => ({ file: `src/file-${index}.ts`, line: index + 1, excerpt: "evidence" }),
  );
  assert.equal(
    analysisPlanSchema.safeParse({
      ...validPlan,
      hypotheses: [{ ...validHypothesis, evidence: evidenceAtLimit }],
    }).success,
    true,
    "8 source evidence items must be accepted",
  );
  assert.equal(
    analysisPlanSchema.safeParse({
      ...validPlan,
      hypotheses: [{
        ...validHypothesis,
        evidence: [...evidenceAtLimit, { file: "src/extra.ts", line: 9, excerpt: "extra" }],
      }],
    }).success,
    false,
    "9 source evidence items must be rejected",
  );

  const assertionsAtLimit = Array.from(
    { length: 8 },
    (_, index) => ({ kind: "status", equals: 200 + index }),
  );
  assert.equal(
    analysisPlanSchema.safeParse(planWithTest({ ...validTest, assertions: assertionsAtLimit })).success,
    true,
    "8 assertions must be accepted",
  );
  assert.equal(
    analysisPlanSchema.safeParse(planWithTest({
      ...validTest,
      assertions: [...assertionsAtLimit, { kind: "status", equals: 208 }],
    })).success,
    false,
    "9 assertions must be rejected",
  );

  const testsAtLimit = Array.from(
    { length: 5 },
    (_, index) => ({ ...validTest, id: `bounded-test-${index}` }),
  );
  assert.equal(
    analysisPlanSchema.safeParse({
      ...validPlan,
      hypotheses: [{ ...validHypothesis, tests: testsAtLimit }],
    }).success,
    true,
    "5 tests must be accepted",
  );
  assert.equal(
    analysisPlanSchema.safeParse({
      ...validPlan,
      hypotheses: [{
        ...validHypothesis,
        tests: [...testsAtLimit, { ...validTest, id: "bounded-test-extra" }],
      }],
    }).success,
    false,
    "6 tests must be rejected",
  );
});

test("analysis plan rejects arbitrary commands and external URLs", () => {
  const commandPlan = planWithTest({
    ...validTest,
    command: "curl evil.test",
  });
  assert.equal(
    analysisPlanSchema.safeParse(commandPlan).success,
    false,
    "an otherwise-valid command-only extension must be rejected",
  );

  const externalUrlPlan = planWithTest({
    ...validTest,
    request: { ...validTest.request, path: "https://evil.test" },
  });
  assert.equal(
    analysisPlanSchema.safeParse(externalUrlPlan).success,
    false,
    "an otherwise-valid external-URL-only mutation must be rejected",
  );

  const duplicateSlashPlan = planWithTest({
    ...validTest,
    request: { ...validTest.request, path: "/api//purchase" },
  });
  assert.equal(analysisPlanSchema.safeParse(duplicateSlashPlan).success, false);

  const requestPathAtLimit = `/api/${"a".repeat(507)}`;
  const requestPathOverLimit = `/api/${"a".repeat(508)}`;
  assert.equal(requestPathAtLimit.length, 512);
  assert.equal(requestPathOverLimit.length, 513);
  assert.equal(
    analysisPlanSchema.safeParse(planWithTest({
      ...validTest,
      request: { ...validTest.request, path: requestPathAtLimit },
    })).success,
    true,
    "512-character request paths must be accepted",
  );
  assert.equal(
    analysisPlanSchema.safeParse(planWithTest({
      ...validTest,
      request: { ...validTest.request, path: requestPathOverLimit },
    })).success,
    false,
    "513-character request paths must be rejected",
  );

  const jsonPathAtLimit = `$.${"a".repeat(510)}`;
  const jsonPathOverLimit = `$.${"a".repeat(511)}`;
  assert.equal(jsonPathAtLimit.length, 512);
  assert.equal(jsonPathOverLimit.length, 513);
  assert.equal(
    analysisPlanSchema.safeParse(planWithTest({
      ...validTest,
      assertions: [{ kind: "json-equals", path: jsonPathAtLimit, equals: true }],
    })).success,
    true,
    "512-character json-equals paths must be accepted",
  );
  assert.equal(
    analysisPlanSchema.safeParse(planWithTest({
      ...validTest,
      assertions: [{ kind: "json-equals", path: jsonPathOverLimit, equals: true }],
    })).success,
    false,
    "513-character json-equals paths must be rejected",
  );

  const parseContractJson = getParseContractJson();
  assertThrowsNamed(
    () => parseContractJson(analysisPlanSchema, "This is not JSON."),
    "SyntaxError",
    "prose must be rejected as invalid JSON",
  );
  assertThrowsNamed(
    () => parseContractJson(analysisPlanSchema, "{"),
    "SyntaxError",
    "malformed JSON must preserve the native SyntaxError",
  );

  const maxBytes = Reflect.get(contracts, "CONTRACT_JSON_MAX_BYTES");
  assert.equal(maxBytes, 262_144);
  assertThrowsNamed(
    () => parseContractJson(analysisPlanSchema, "{".repeat(maxBytes + 1)),
    "RangeError",
    "serialized input over 256 KiB must fail before JSON parsing",
  );
});

test("execution result cannot mark an unexecuted hypothesis confirmed", () => {
  const unexecuted = {
    runId: "run-1",
    hypothesisId: "price-authority",
    verdict: "CONFIRMED",
    executed: false,
    evidence: [validEvidence],
  };
  assert.equal(
    executionResultSchema.safeParse(unexecuted).success,
    false,
    "CONFIRMED with executed=false must be rejected",
  );

  const emptyEvidence = {
    ...unexecuted,
    executed: true,
    evidence: [],
  };
  assert.equal(
    executionResultSchema.safeParse(emptyEvidence).success,
    false,
    "CONFIRMED with empty evidence must be rejected",
  );

  const evidenceAtLimit = {
    ...unexecuted,
    executed: true,
    evidence: Array.from({ length: 64 }, () => ({ ...validEvidence })),
  };
  assert.equal(
    executionResultSchema.safeParse(evidenceAtLimit).success,
    true,
    "64 execution evidence items must be accepted",
  );
  assert.equal(
    executionResultSchema.safeParse({
      ...evidenceAtLimit,
      evidence: [...evidenceAtLimit.evidence, { ...validEvidence }],
    }).success,
    false,
    "65 execution evidence items must be rejected",
  );
});

test("execution result requires an executed BLOCKED verdict with empty evidence", () => {
  const blocked = {
    runId: "run-1",
    hypothesisId: "price-authority",
    verdict: "BLOCKED",
    executed: true,
    evidence: [],
  };
  assert.equal(
    executionResultSchema.safeParse(blocked).success,
    true,
    "BLOCKED with executed=true and empty evidence must be accepted",
  );
  assert.equal(
    executionResultSchema.safeParse({ ...blocked, executed: false }).success,
    false,
    "BLOCKED with executed=false must be rejected",
  );
  assert.equal(
    executionResultSchema.safeParse({ ...blocked, evidence: [validEvidence] }).success,
    false,
    "BLOCKED with evidence must be rejected",
  );

  for (const validFailClosed of [
    { ...blocked, verdict: "UNVERIFIED", executed: false, evidence: [] },
    { ...blocked, verdict: "ERROR", executed: false, evidence: [validEvidence] },
  ]) {
    assert.equal(
      executionResultSchema.safeParse(validFailClosed).success,
      true,
      `${validFailClosed.verdict} semantics must remain valid`,
    );
  }
});
