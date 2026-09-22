import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  analysisPlanSchema,
  type ExecutionResult,
} from "@trustgate/contracts";

import fixturePlan from "../../src/fixture-plan.json" with { type: "json" };
import { createSandboxRunner } from "../../src/sandbox-runner.js";
import { classifyRegression } from "../../src/verdict.js";

const SANDBOX_IMAGE = "localhost/trustgate-target:sandbox";
const gated = { skip: process.env.RUN_PODMAN_E2E !== "1" };

type ExpectedResult = {
  runId: string;
  hypothesisId: string;
  verdict: "CONFIRMED" | "BLOCKED";
  executed: true;
  evidence: ExecutionResult["evidence"];
};

/**
 * Measured on the real rootless Podman sandbox (brief §5): vulnerable target
 * fails every assertion, patched target satisfies all of them.
 */
const EXPECTED_VULNERABLE: ExpectedResult[] = [
  {
    runId: "spec-negative-price",
    hypothesisId: "price-authority",
    verdict: "CONFIRMED",
    executed: true,
    evidence: [
      { kind: "status", expected: 400, actual: 200 },
      { kind: "state-delta", expected: 0, actual: 100 },
    ],
  },
  {
    runId: "spec-underpriced-price",
    hypothesisId: "price-authority",
    verdict: "CONFIRMED",
    executed: true,
    evidence: [
      { kind: "status", expected: 400, actual: 200 },
      { kind: "state-delta", expected: 0, actual: -1 },
    ],
  },
  {
    runId: "spec-foreign-transfer",
    hypothesisId: "ownership-check",
    verdict: "CONFIRMED",
    executed: true,
    evidence: [
      { kind: "status", expected: 403, actual: 200 },
      { kind: "state-delta", expected: 0, actual: 1 },
    ],
  },
];

const EXPECTED_PATCHED: ExpectedResult[] = EXPECTED_VULNERABLE.map((result) => ({
  runId: result.runId,
  hypothesisId: result.hypothesisId,
  verdict: "BLOCKED" as const,
  executed: true as const,
  evidence: [],
}));

test(
  "vulnerable is confirmed and patched is blocked on the real sandbox",
  gated,
  async () => {
    const runtimeDir = join(homedir(), ".cache", "trustgate-e2e");
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const plan = analysisPlanSchema.parse({
      version: fixturePlan.version,
      hypotheses: fixturePlan.hypotheses,
    });
    const runner = createSandboxRunner({
      image: SANDBOX_IMAGE,
      hostRuntime: { home: homedir(), xdgRuntimeDir: runtimeDir },
    });

    const vulnerable = await runner.run("vulnerable", plan);
    const patched = await runner.run("patched", plan);

    // The real container output matches the measured table entry by entry.
    assert.deepEqual(vulnerable, EXPECTED_VULNERABLE);
    assert.deepEqual(patched, EXPECTED_PATCHED);
    assert.deepEqual(
      vulnerable.map((result, index) =>
        classifyRegression(result.verdict, patched[index]!.verdict),
      ),
      ["FIXED", "FIXED", "FIXED"],
    );
  },
);
