import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  analysisPlanSchema,
  executionResultSchema,
} from "@trustgate/contracts";

import fixturePlan from "../../src/fixture-plan.json" with { type: "json" };
import { createSandboxRunner } from "../../src/sandbox-runner.js";
import { classifyRegression } from "../../src/verdict.js";

/**
 * Same absolute executable as the runner's `DEFAULT_PODMAN_EXECUTABLE`
 * (`src/sandbox-runner.ts`): the sandbox trust boundary pins Podman to an
 * absolute, normalized path and never resolves it through PATH, so the preflight
 * probes exactly the binary the runner is about to execute.
 */
const PODMAN_EXECUTABLE = "/usr/bin/podman";
const SANDBOX_IMAGE = "localhost/trustgate-target:sandbox";

/**
 * The runner rejects a run whenever the Podman process leaves a single byte on
 * stderr and may only report the generic `sandbox execution failed` — putting
 * stderr content into that message is forbidden by the security contract (see
 * `sandbox-runner.test.ts`). A missing image would therefore surface as an opaque
 * generic failure, so the preflight in the test body names the real cause first.
 * The `cgroupfs` pin in `sandbox-policy.ts` keeps this environment's Podman
 * stderr empty, which is why the run itself stays silent.
 */
const gated = {
  skip:
    process.env.RUN_PODMAN_E2E !== "1"
      ? "requires RUN_PODMAN_E2E=1"
      : false,
};

test(
  "vulnerable is confirmed and patched is blocked on the real sandbox",
  gated,
  async () => {
    const probe = spawnSync(
      PODMAN_EXECUTABLE,
      ["image", "inspect", SANDBOX_IMAGE, "--format", "{{.Id}}"],
      { encoding: "utf8" },
    );
    assert.equal(
      probe.error,
      undefined,
      `podman executable unavailable: ${PODMAN_EXECUTABLE} (${String(probe.error?.message)})`,
    );
    assert.equal(
      probe.status,
      0,
      `sandbox image ${SANDBOX_IMAGE} is missing — run: node scripts/build-demo-image.mjs`,
    );

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

    // `fixture-plan.json` is the recorded replay snapshot of the measured run and
    // the single source of truth for the expected verdicts and evidence (brief §5
    // measured table). It is parsed against the execution contract first, so a
    // drifted fixture fails loudly here instead of silently redefining the
    // expectation, and nothing is hand-copied into this test.
    const expectedVulnerable = executionResultSchema
      .array()
      .parse(fixturePlan.vulnerableResults);
    const expectedPatched = executionResultSchema
      .array()
      .parse(fixturePlan.patchedResults);

    const vulnerable = await runner.run("vulnerable", plan);
    const patched = await runner.run("patched", plan);

    // The real container output matches the recorded snapshot entry by entry.
    assert.deepEqual(vulnerable, expectedVulnerable);
    assert.deepEqual(patched, expectedPatched);

    // Brief §5: every recorded pair is CONFIRMED → BLOCKED, i.e. FIXED. The
    // expected regression column is derived from the fixture (one pair per
    // recorded result), never hand-copied.
    assert.deepEqual(
      vulnerable.map((result, index) =>
        classifyRegression(result.verdict, patched[index]!.verdict),
      ),
      expectedVulnerable.map(() => "FIXED"),
    );
  },
);
