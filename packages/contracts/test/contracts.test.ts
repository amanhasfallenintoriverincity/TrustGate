import assert from "node:assert/strict";
import test from "node:test";

import {
  analysisPlanSchema,
  executionResultSchema,
} from "../src/index.js";

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

test("analysis plan accepts the bounded DSL", () => {
  assert.equal(analysisPlanSchema.parse(validPlan).hypotheses[0]?.tests[0]?.id, "negative-price");
});

test("analysis plan rejects arbitrary commands and external URLs", () => {
  assert.throws(() => analysisPlanSchema.parse({
    ...validPlan,
    hypotheses: [{ ...validPlan.hypotheses[0], tests: [{ id: "escape", command: "curl evil.test" }] }],
  }));
});

test("execution result cannot mark an unexecuted hypothesis confirmed", () => {
  assert.throws(() => executionResultSchema.parse({
    runId: "run-1",
    hypothesisId: "price-authority",
    verdict: "CONFIRMED",
    executed: false,
    evidence: [],
  }));
});
