import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  analysisPlanSchema,
  executionResultSchema,
  JSON_MAX_DEPTH,
  jsonValueSchema,
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

const validHypothesis = validPlan.hypotheses[0]!;
const validTest = validHypothesis.tests[0]!;

function planWithTest(testSpec: unknown) {
  return {
    ...validPlan,
    hypotheses: [{
      ...validHypothesis,
      tests: [testSpec],
    }],
  };
}

test("analysis plan accepts the bounded DSL", () => {
  assert.equal(analysisPlanSchema.parse(validPlan).hypotheses[0]?.tests[0]?.id, "negative-price");

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

  const nullPrototypeBody = Object.assign(Object.create(null) as Record<string, unknown>, {
    itemId: "shield",
    price: 25,
  });
  const nullPrototypePlan = planWithTest({
    ...validTest,
    request: { ...validTest.request, body: nullPrototypeBody },
  });
  assert.equal(
    analysisPlanSchema.safeParse(nullPrototypePlan).success,
    true,
    "null-prototype JSON records must be accepted",
  );

  let bodyAtDepthLimit: unknown = "leaf";
  for (let depth = 0; depth < JSON_MAX_DEPTH; depth += 1) {
    bodyAtDepthLimit = [bodyAtDepthLimit];
  }
  const depthLimitPlan = planWithTest({
    ...validTest,
    request: { ...validTest.request, body: bodyAtDepthLimit },
  });
  assert.equal(
    analysisPlanSchema.safeParse(depthLimitPlan).success,
    true,
    "JSON at the depth limit must be accepted",
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
    "command must be rejected",
  );

  const externalUrlPlan = planWithTest({
    ...validTest,
    request: { ...validTest.request, path: "https://evil.test" },
  });
  assert.equal(
    analysisPlanSchema.safeParse(externalUrlPlan).success,
    false,
    "external URL must be rejected",
  );

  const duplicateSlashPlan = planWithTest({
    ...validTest,
    request: { ...validTest.request, path: "/api//purchase" },
  });
  assert.equal(
    analysisPlanSchema.safeParse(duplicateSlashPlan).success,
    false,
    "duplicate slash must be rejected",
  );

  const pathAtLimitPlan = planWithTest({
    ...validTest,
    request: { ...validTest.request, path: `/api/${"a".repeat(507)}` },
  });
  assert.equal(
    analysisPlanSchema.safeParse(pathAtLimitPlan).success,
    true,
    "512-character request paths must be accepted",
  );

  const overlongPathPlan = planWithTest({
    ...validTest,
    request: { ...validTest.request, path: `/api/${"a".repeat(508)}` },
  });
  assert.equal(
    analysisPlanSchema.safeParse(overlongPathPlan).success,
    false,
    "request paths over 512 characters must be rejected",
  );

  const pathDescriptorProbe = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    [
      'import { analysisPlanSchema } from "./packages/contracts/src/index.ts";',
      `const plan = ${JSON.stringify(validPlan)};`,
      "for (const descriptor of [",
      '  { configurable: true, value: "https://evil.test", writable: false },',
      '  { configurable: true, get: () => "https://evil.test" },',
      "]) {",
      '  Object.defineProperty(Object.prototype, "path", descriptor);',
      "  let result;",
      "  try { result = analysisPlanSchema.safeParse(plan); } catch { process.exit(1); }",
      "  if (result.success) process.exit(1);",
      '  delete Object.prototype.path;',
      "}",
    ].join("\n"),
  ], {
    cwd: new URL("../../..", import.meta.url),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(
    pathDescriptorProbe.status,
    0,
    `strong Object.prototype.path descriptors must fail closed without throwing (signal=${pathDescriptorProbe.signal}, stderr=${pathDescriptorProbe.stderr})`,
  );

  const jsonEqualsPathAtLimit = `$.${"a".repeat(510)}`;
  assert.equal(jsonEqualsPathAtLimit.length, 512);
  assert.equal(
    analysisPlanSchema.safeParse(planWithTest({
      ...validTest,
      assertions: [{ kind: "json-equals", path: jsonEqualsPathAtLimit, equals: true }],
    })).success,
    true,
    "512-character json-equals paths must be accepted",
  );
  const overlongJsonEqualsPath = `$.${"a".repeat(511)}`;
  assert.equal(overlongJsonEqualsPath.length, 513);
  assert.equal(
    analysisPlanSchema.safeParse(planWithTest({
      ...validTest,
      assertions: [{ kind: "json-equals", path: overlongJsonEqualsPath, equals: true }],
    })).success,
    false,
    "json-equals paths over 512 characters must be rejected",
  );

  assert.equal(
    jsonValueSchema.safeParse({ ["k".repeat(256)]: true }).success,
    true,
    "256-character JSON record keys must be accepted",
  );
  assert.equal(
    jsonValueSchema.safeParse({ ["k".repeat(257)]: true }).success,
    false,
    "JSON record keys over 256 characters must be rejected",
  );

  const previousMethod = Object.getOwnPropertyDescriptor(Object.prototype, "method");
  try {
    Object.defineProperty(Object.prototype, "method", {
      configurable: true,
      value: "POST",
      writable: true,
    });
    const pollutedMethodPlan = planWithTest({
      ...validTest,
      request: { path: "/api/purchase" },
    });
    assert.equal(
      analysisPlanSchema.safeParse(pollutedMethodPlan).success,
      false,
      "Object.prototype.method must not satisfy an own method requirement",
    );
  } finally {
    if (previousMethod === undefined) {
      delete (Object.prototype as Record<string, unknown>).method;
    } else {
      Object.defineProperty(Object.prototype, "method", previousMethod);
    }
  }

  const previousBody = Object.getOwnPropertyDescriptor(Object.prototype, "body");
  try {
    Object.defineProperty(Object.prototype, "body", {
      configurable: true,
      value: { poisoned: true },
      writable: true,
    });
    const inheritedBodyPlan = planWithTest({
      ...validTest,
      request: { method: "POST", path: "/api/purchase" },
    });
    const inheritedBodyResult = analysisPlanSchema.safeParse(inheritedBodyPlan);
    assert.equal(inheritedBodyResult.success, true, "inherited optional body must be ignored");
    if (inheritedBodyResult.success) {
      assert.equal(
        Object.hasOwn(inheritedBodyResult.data.hypotheses[0]!.tests[0]!.request, "body"),
        false,
        "inherited optional body must not appear in parsed data",
      );
    }
  } finally {
    if (previousBody === undefined) {
      delete (Object.prototype as Record<string, unknown>).body;
    } else {
      Object.defineProperty(Object.prototype, "body", previousBody);
    }
  }

  const inheritedMethodRequest = Object.assign(
    Object.create({ method: "POST" }) as Record<string, unknown>,
    { path: "/api/purchase", body: { itemId: "sword", price: -100 } },
  );
  const inheritedMethodPlan = planWithTest({
    ...validTest,
    request: inheritedMethodRequest,
  });
  assert.equal(
    analysisPlanSchema.safeParse(inheritedMethodPlan).success,
    false,
    "inherited method must be rejected",
  );

  const customPrototypeBody = Object.assign(
    Object.create({ inherited: "not-json-input" }) as Record<string, unknown>,
    { itemId: "sword", price: -100 },
  );
  const customPrototypeJsonPlan = planWithTest({
    ...validTest,
    request: { ...validTest.request, body: customPrototypeBody },
  });
  assert.equal(
    analysisPlanSchema.safeParse(customPrototypeJsonPlan).success,
    false,
    "custom-prototype JSON record must be rejected",
  );

  const nonJsonBodies = [
    { label: "Date", value: new Date() },
    { label: "class instance", value: new (class JsonImposter { value = 1; })() },
    { label: "function", value: () => undefined },
    { label: "NaN", value: Number.NaN },
    { label: "Infinity", value: Number.POSITIVE_INFINITY },
    { label: "-Infinity", value: Number.NEGATIVE_INFINITY },
  ];
  for (const { label, value: body } of nonJsonBodies) {
    const nonJsonPlan = planWithTest({
      ...validTest,
      request: { ...validTest.request, body },
    });
    assert.equal(
      analysisPlanSchema.safeParse(nonJsonPlan).success,
      false,
      `${label} request body must be rejected`,
    );
  }

  const undefinedBodyPlan = planWithTest({
    ...validTest,
    request: { ...validTest.request, body: undefined },
  });
  assert.equal(
    analysisPlanSchema.safeParse(undefinedBodyPlan).success,
    false,
    "explicit undefined request body must be rejected",
  );

  let bodyOverDepthLimit: unknown = "leaf";
  for (let depth = 0; depth <= JSON_MAX_DEPTH; depth += 1) {
    bodyOverDepthLimit = [bodyOverDepthLimit];
  }
  const overDepthLimitPlan = planWithTest({
    ...validTest,
    request: { ...validTest.request, body: bodyOverDepthLimit },
  });
  assert.equal(
    analysisPlanSchema.safeParse(overDepthLimitPlan).success,
    false,
    "JSON over the depth limit must be rejected",
  );

  const jsonArrayDescriptorProbe = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    [
      'import { jsonValueSchema } from "./packages/contracts/src/index.ts";',
      "for (const target of [Object.prototype, Array.prototype]) {",
      "  for (const descriptor of [",
      '    { configurable: true, value: "inherited-array-value", writable: false },',
      '    { configurable: true, get: () => "inherited-array-value" },',
      "  ]) {",
      '    Object.defineProperty(target, "0", descriptor);',
      "    let denseResult;",
      "    let sparseResult;",
      "    try {",
      "      denseResult = jsonValueSchema.safeParse([1]);",
      "      sparseResult = jsonValueSchema.safeParse(new Array(1));",
      "    } catch { process.exit(1); }",
      "    if (!denseResult.success || !Array.isArray(denseResult.data) || sparseResult.success) process.exit(1);",
      '    delete target["0"];',
      "  }",
      "}",
    ].join("\n"),
  ], {
    cwd: new URL("../../..", import.meta.url),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(
    jsonArrayDescriptorProbe.status,
    0,
    `strong numeric descriptors must accept dense and reject sparse JSON arrays without throwing (signal=${jsonArrayDescriptorProbe.signal}, stderr=${jsonArrayDescriptorProbe.stderr})`,
  );

  const hugeSparseProbe = spawnSync(process.execPath, [
    "--max-old-space-size=64",
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    [
      'import { jsonValueSchema } from "./packages/contracts/src/index.ts";',
      "const started = performance.now();",
      "const result = jsonValueSchema.safeParse(new Array(1_000_000));",
      "if (result.success || performance.now() - started >= 1_000) process.exit(1);",
    ].join("\n"),
  ], {
    cwd: new URL("../../..", import.meta.url),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(
    hugeSparseProbe.status,
    0,
    `huge sparse JSON arrays must fail fast in 64 MiB (signal=${hugeSparseProbe.signal}, stderr=${hugeSparseProbe.stderr})`,
  );

  let deeplyNestedJson: unknown = "leaf";
  for (let depth = 0; depth < 2_000; depth += 1) {
    deeplyNestedJson = [deeplyNestedJson];
  }
  const deeplyNestedPlan = planWithTest({
    ...validTest,
    request: { ...validTest.request, body: deeplyNestedJson },
  });
  let depthResult: ReturnType<typeof analysisPlanSchema.safeParse> | undefined;
  assert.doesNotThrow(() => {
    depthResult = analysisPlanSchema.safeParse(deeplyNestedPlan);
  });
  assert.equal(depthResult?.success, false, "deep JSON must be rejected cleanly");
});

test("execution result cannot mark an unexecuted hypothesis confirmed", () => {
  const validEvidence = { kind: "status", expected: 400, actual: 400 };
  const unexecuted = {
    runId: "run-1",
    hypothesisId: "price-authority",
    verdict: "CONFIRMED",
    executed: false,
    evidence: [],
  };
  assert.equal(
    executionResultSchema.safeParse(unexecuted).success,
    false,
    "unexecuted CONFIRMED result must be rejected",
  );

  const emptyEvidence = {
    ...unexecuted,
    executed: true,
  };
  assert.equal(
    executionResultSchema.safeParse(emptyEvidence).success,
    false,
    "CONFIRMED with empty evidence must be rejected",
  );

  const inheritedExecuted = Object.assign(
    Object.create({ executed: true }) as Record<string, unknown>,
    {
      runId: "run-1",
      hypothesisId: "price-authority",
      verdict: "CONFIRMED",
      evidence: [{ kind: "status", expected: 400, actual: 400 }],
    },
  );
  assert.equal(
    executionResultSchema.safeParse(inheritedExecuted).success,
    false,
    "inherited executed must be rejected",
  );

  const previousExecuted = Object.getOwnPropertyDescriptor(Object.prototype, "executed");
  try {
    Object.defineProperty(Object.prototype, "executed", {
      configurable: true,
      value: true,
      writable: true,
    });
    const pollutedExecuted = {
      runId: "run-1",
      hypothesisId: "price-authority",
      verdict: "CONFIRMED",
      evidence: [validEvidence],
    };
    assert.equal(
      executionResultSchema.safeParse(pollutedExecuted).success,
      false,
      "Object.prototype.executed must not satisfy an own executed requirement",
    );
  } finally {
    if (previousExecuted === undefined) {
      delete (Object.prototype as Record<string, unknown>).executed;
    } else {
      Object.defineProperty(Object.prototype, "executed", previousExecuted);
    }
  }

  const executedDescriptorProbe = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    [
      'import { executionResultSchema } from "./packages/contracts/src/index.ts";',
      `const input = ${JSON.stringify({
        runId: "run-1",
        hypothesisId: "price-authority",
        verdict: "CONFIRMED",
        executed: true,
        evidence: [validEvidence],
      })};`,
      "for (const descriptor of [",
      "  { configurable: true, value: true, writable: false },",
      "  { configurable: true, get: () => true },",
      "]) {",
      '  Object.defineProperty(Object.prototype, "executed", descriptor);',
      "  let result;",
      "  try { result = executionResultSchema.safeParse(input); } catch { process.exit(1); }",
      '  if (result.success && (!Object.hasOwn(result.data, "executed") || result.data.executed !== true)) process.exit(1);',
      '  delete Object.prototype.executed;',
      "}",
    ].join("\n"),
  ], {
    cwd: new URL("../../..", import.meta.url),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(
    executedDescriptorProbe.status,
    0,
    `strong Object.prototype.executed descriptors must fail closed or preserve an own true value without throwing (signal=${executedDescriptorProbe.signal}, stderr=${executedDescriptorProbe.stderr})`,
  );

  const previousEvidence = Object.getOwnPropertyDescriptor(Object.prototype, "evidence");
  try {
    Object.defineProperty(Object.prototype, "evidence", {
      configurable: true,
      value: [validEvidence],
      writable: true,
    });
    const pollutedEvidence = {
      runId: "run-1",
      hypothesisId: "price-authority",
      verdict: "CONFIRMED",
      executed: true,
    };
    assert.equal(
      executionResultSchema.safeParse(pollutedEvidence).success,
      false,
      "Object.prototype.evidence must not satisfy an own evidence requirement",
    );
  } finally {
    if (previousEvidence === undefined) {
      delete (Object.prototype as Record<string, unknown>).evidence;
    } else {
      Object.defineProperty(Object.prototype, "evidence", previousEvidence);
    }
  }

  const evidenceArrayDescriptorProbe = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    [
      'import { executionResultSchema } from "./packages/contracts/src/index.ts";',
      `const evidence = ${JSON.stringify(validEvidence)};`,
      "for (const target of [Object.prototype, Array.prototype]) {",
      "  for (const descriptor of [",
      "    { configurable: true, value: evidence, writable: false },",
      "    { configurable: true, get: () => evidence },",
      "  ]) {",
      '    Object.defineProperty(target, "0", descriptor);',
      '    const base = { runId: "run-1", hypothesisId: "price-authority", verdict: "CONFIRMED", executed: true };',
      "    let denseResult;",
      "    let sparseResult;",
      "    try {",
      "      denseResult = executionResultSchema.safeParse({ ...base, evidence: [evidence] });",
      "      sparseResult = executionResultSchema.safeParse({ ...base, evidence: new Array(1) });",
      "    } catch { process.exit(1); }",
      "    if (!denseResult.success || !Array.isArray(denseResult.data.evidence) || sparseResult.success) process.exit(1);",
      '    delete target["0"];',
      "  }",
      "}",
    ].join("\n"),
  ], {
    cwd: new URL("../../..", import.meta.url),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(
    evidenceArrayDescriptorProbe.status,
    0,
    `strong numeric descriptors must accept dense and reject sparse execution evidence without throwing (signal=${evidenceArrayDescriptorProbe.signal}, stderr=${evidenceArrayDescriptorProbe.stderr})`,
  );

  const evidenceAtLimit = Object.assign(Object.create(null) as Record<string, unknown>, {
    runId: "run-1",
    hypothesisId: "price-authority",
    verdict: "CONFIRMED",
    executed: true,
    evidence: Array.from({ length: 64 }, () => ({ ...validEvidence })),
  });
  assert.equal(
    executionResultSchema.safeParse(evidenceAtLimit).success,
    true,
    "64 execution evidence items must be accepted",
  );

  const evidenceOverLimit = {
    ...evidenceAtLimit,
    evidence: Array.from({ length: 65 }, () => ({ ...validEvidence })),
  };
  assert.equal(
    executionResultSchema.safeParse(evidenceOverLimit).success,
    false,
    "65 execution evidence items must be rejected",
  );
});
