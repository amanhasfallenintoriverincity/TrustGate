#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = join(root, "artifacts", "demo-report.json");
const gates = [
  ["npm", ["ci"]],
  ["npm", ["run", "check"]],
  ["podman", ["build", "-f", "apps/demo-target/Containerfile.sandbox", "-t", "localhost/trustgate-target:sandbox", "."]],
  ["npm", ["test", "-w", "@trustgate/orchestrator"]],
  ["npm", ["run", "e2e", "-w", "@trustgate/web"]],
  ["npm", ["audit", "--omit=dev", "--workspaces"]],
];

export function runGates(spawn = spawnSync) {
  for (const [index, [command, args]] of gates.entries()) {
    process.stdout.write(`release gate ${index + 1}/${gates.length}: ${command} ${args.join(" ")}\n`);
    const result = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: false,
      env: { ...process.env, RUN_PODMAN_E2E: index === 3 ? "1" : undefined },
    });
    if (result.error || result.status !== 0) {
      process.stderr.write(`release gate ${index + 1} failed\n`);
      return Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    }
  }
  return 0;
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function validateDemoReport(report) {
  assert.ok(isRecord(report), "report must be an object");
  assert.equal(report.source, "fixture");
  assert.match(report.runId, /^run-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(report.regressionVerdict, "FIXED");
  assert.ok(Array.isArray(report.vulnerableResults) && report.vulnerableResults.length === 3);
  assert.ok(Array.isArray(report.patchedResults) && report.patchedResults.length === 3);
  assert.ok(Array.isArray(report.hypotheses) && report.hypotheses.length > 0);
  const vulnerable = new Map();
  const patched = new Map();
  for (const [results, verdict, destination] of [
    [report.vulnerableResults, "CONFIRMED", vulnerable],
    [report.patchedResults, "BLOCKED", patched],
  ]) {
    for (const result of results) {
      assert.ok(isRecord(result) && typeof result.runId === "string");
      assert.equal(result.verdict, verdict);
      assert.equal(result.executed, true);
      assert.ok(Array.isArray(result.evidence));
      assert.ok(!destination.has(result.runId));
      destination.set(result.runId, result);
    }
  }
  assert.ok([...vulnerable.values()].some(({ evidence }) =>
    evidence.some((item) => isRecord(item) && typeof item.kind === "string" &&
      Object.hasOwn(item, "expected") && Object.hasOwn(item, "actual") &&
      item.expected !== item.actual)), "missing observed evidence");
  let tests = 0;
  for (const hypothesis of report.hypotheses) {
    assert.ok(isRecord(hypothesis));
    assert.equal(hypothesis.regressionVerdict, "FIXED");
    assert.ok(Array.isArray(hypothesis.tests) && hypothesis.tests.length > 0);
    for (const entry of hypothesis.tests) {
      assert.ok(isRecord(entry));
      assert.equal(entry.regressionVerdict, "FIXED");
      assert.equal(entry.vulnerableResult?.hypothesisId, hypothesis.id);
      assert.equal(entry.patchedResult?.hypothesisId, hypothesis.id);
      assert.deepEqual(entry.vulnerableResult, vulnerable.get(`spec-${entry.id}`));
      assert.deepEqual(entry.patchedResult, patched.get(`spec-${entry.id}`));
      tests++;
    }
  }
  assert.equal(tests, 3);
  // Fail closed before committing raw API bytes, without logging any rejected content.
  const text = JSON.stringify(report);
  assert.ok(!text.includes(homedir()), "absolute home path in report");
  assert.doesNotMatch(text, /(?:\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|\b(?:gh[opsur]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:authorization|bearer|api[-_]?key|access[-_]?token|password|secret)\s*[:=]\s*\S+)/i);
  return report;
}

export function compareDemoReports(saved, fresh) {
  validateDemoReport(saved);
  validateDemoReport(fresh);
  const { runId: savedId, ...savedBody } = saved;
  const { runId: freshId, ...freshBody } = fresh;
  assert.notEqual(savedId, freshId, "fixture did not generate a fresh runId");
  assert.deepEqual(freshBody, savedBody, "fixture report drift");
}

async function captureDemoReport() {
  // Import the just-built server after all six gates, not a stale dist file.
  const { buildServer } = await import("../apps/orchestrator/dist/server.js");
  const app = buildServer({ mode: "fixture" });
  let body;
  try {
    const response = await app.inject({ method: "POST", url: "/api/runs", payload: { source: "fixture" } });
    assert.equal(response.statusCode, 201, "fixture API did not return 201");
    body = response.body;
  } finally {
    await app.close();
  }
  const fresh = validateDemoReport(JSON.parse(body));
  let savedBody;
  try {
    savedBody = await readFile(artifact, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (savedBody === undefined) {
    await mkdir(dirname(artifact), { recursive: true });
    await writeFile(artifact, body, { flag: "wx" });
    assert.equal(await readFile(artifact, "utf8"), body, "artifact readback mismatch");
    validateDemoReport(JSON.parse(await readFile(artifact, "utf8")));
    process.stdout.write("release fixture: captured HTTP 201 body and verified JSON readback\n");
  } else {
    compareDemoReports(validateDemoReport(JSON.parse(savedBody)), fresh);
    process.stdout.write("release fixture: HTTP 201 matches existing verified report (except runId)\n");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runGates();
  if (result !== 0) process.exitCode = result;
  else {
    try {
      await captureDemoReport();
    } catch {
      process.stderr.write("release fixture validation or readback failed\n");
      process.exitCode = 1;
    }
  }
}
