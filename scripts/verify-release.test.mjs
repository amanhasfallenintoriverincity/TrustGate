import assert from "node:assert/strict";
import test from "node:test";

import { buildServer } from "../apps/orchestrator/dist/server.js";
import { runGates, validateDemoReport, compareDemoReports } from "./verify-release.mjs";

test("second gate failure returns nonzero and skips every later gate", () => {
  const calls = [];
  const code = runGates((command, args, options) => {
    calls.push({ command, args, options });
    return { status: calls.length === 2 ? 42 : 0 };
  });

  assert.equal(code, 42);
  assert.deepEqual(
    calls.map(({ command, args }) => [command, args]),
    [
      ["npm", ["ci"]],
      ["npm", ["run", "check"]],
    ],
  );
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test("all gates run in order, with Podman E2E enabled only for orchestrator", () => {
  const calls = [];
  const code = runGates((command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  });
  assert.equal(code, 0);
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ["npm", ["ci"]],
    ["npm", ["run", "check"]],
    ["podman", ["build", "-f", "apps/demo-target/Containerfile.sandbox", "-t", "localhost/trustgate-target:sandbox", "."]],
    ["npm", ["test", "-w", "@trustgate/orchestrator"]],
    ["npm", ["run", "e2e", "-w", "@trustgate/web"]],
    ["npm", ["audit", "--omit=dev", "--workspaces"]],
  ]);
  assert.ok(calls.every(({ options }) => options.shell === false));
  assert.equal(calls[3].options.env.RUN_PODMAN_E2E, "1");
  assert.ok(calls.every(({ options }, index) => index === 3 || options.env.RUN_PODMAN_E2E === undefined));
});

test("spawn errors fail closed and never reach later gates", () => {
  let calls = 0;
  const code = runGates(() => {
    calls++;
    return { error: new Error("spawn failed"), status: null };
  });
  assert.equal(code, 1);
  assert.equal(calls, 1);
});

test("validates actual fixture API evidence, verdicts, and detects snapshot drift", async () => {
  const app = buildServer({ mode: "fixture" });
  let report;
  let secondReport;
  try {
    const response = await app.inject({ method: "POST", url: "/api/runs", payload: { source: "fixture" } });
    assert.equal(response.statusCode, 201);
    report = JSON.parse(response.body);
    const second = await app.inject({ method: "POST", url: "/api/runs", payload: { source: "fixture" } });
    assert.equal(second.statusCode, 201);
    secondReport = JSON.parse(second.body);
  } finally {
    await app.close();
  }
  assert.doesNotThrow(() => validateDemoReport(report));
  assert.doesNotThrow(() => compareDemoReports(report, secondReport));
  assert.throws(() => validateDemoReport({ ...report, patchedResults: [] }));
  assert.throws(() => validateDemoReport({ ...report, vulnerableResults: report.vulnerableResults.map((result) => ({ ...result, evidence: [] })) }));
  assert.throws(() => compareDemoReports(report, { ...secondReport, model: "drifted" }), /fixture report drift/);
});
