import assert from "node:assert/strict";
import test from "node:test";

import {
  analysisPlanSchema,
  executionResultSchema,
} from "@trustgate/contracts";

import fixturePlan from "../src/fixture-plan.json" with { type: "json" };

/**
 * `fixture-plan.json` is a recorded replay snapshot: fixture mode in `server.ts`
 * replays it verbatim and re-executes nothing, so the verdict *values* it holds
 * can only be verified by the container E2E (`test/e2e/sandbox.e2e.test.ts`),
 * which re-runs the same plan on the real sandbox and deep-equals the live output
 * against these arrays.
 *
 * These unit tests therefore pin the snapshot's structure and internal
 * invariants only — contract shape, verdict states, identity order, duration
 * arithmetic, metadata presence. They deliberately do not restate the recorded
 * numbers, so a genuine re-measurement does not have to edit any unit test.
 */

const plannedIdentities = analysisPlanSchema
  .parse({ version: fixturePlan.version, hypotheses: fixturePlan.hypotheses })
  .hypotheses.flatMap((hypothesis) =>
    hypothesis.tests.map((spec) => ({
      runId: `spec-${spec.id}`,
      hypothesisId: hypothesis.id,
    })),
  );

const identitiesOf = (results: { runId: string; hypothesisId: string }[]) =>
  results.map(({ runId, hypothesisId }) => ({ runId, hypothesisId }));

test("recorded results satisfy the execution result contract", () => {
  const vulnerable = executionResultSchema
    .array()
    .parse(fixturePlan.vulnerableResults);
  const patched = executionResultSchema.array().parse(fixturePlan.patchedResults);

  assert.ok(vulnerable.length > 0);
  assert.equal(vulnerable.length, patched.length);
  assert.ok(
    vulnerable.every(
      (result) =>
        result.verdict === "CONFIRMED" &&
        result.executed &&
        result.evidence.length > 0,
    ),
  );
  assert.ok(
    patched.every(
      (result) =>
        result.verdict === "BLOCKED" &&
        result.executed &&
        result.evidence.length === 0,
    ),
  );
});

test("recorded result identities follow the fixture plan order", () => {
  const vulnerable = executionResultSchema
    .array()
    .parse(fixturePlan.vulnerableResults);
  const patched = executionResultSchema.array().parse(fixturePlan.patchedResults);

  assert.deepEqual(identitiesOf(vulnerable), plannedIdentities);
  assert.deepEqual(identitiesOf(patched), plannedIdentities);
});

test("recorded durations add up to the reported total", () => {
  const durations = fixturePlan.durations;
  for (const [key, value] of Object.entries(durations)) {
    assert.ok(
      Number.isSafeInteger(value) && value >= 0,
      `durations.${key} must be a non-negative safe integer, got ${String(value)}`,
    );
  }
  assert.equal(
    durations.totalMs,
    durations.ocrMs + durations.planningMs + durations.vulnerableMs + durations.patchedMs,
  );
});

test("replay metadata identifies the recorded run", () => {
  assert.equal(fixturePlan.version, 1);
  for (const key of ["provider", "model"] as const) {
    assert.ok(fixturePlan[key].length > 0, `${key} must not be empty`);
  }
  assert.ok(fixturePlan.reviewedFiles.length > 0, "reviewedFiles must not be empty");
  assert.ok(
    fixturePlan.reviewedFiles.every((file) => file.length > 0),
    "reviewedFiles entries must not be empty",
  );
});
