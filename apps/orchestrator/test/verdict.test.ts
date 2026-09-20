import assert from "node:assert/strict";
import test from "node:test";

import type { ExecutionResult } from "@trustgate/contracts";

import { classifyRegression } from "../src/verdict.js";

test("confirmed before and blocked after is fixed", () => {
  assert.equal(classifyRegression("CONFIRMED", "BLOCKED"), "FIXED");
});

test("confirmed in both versions is still vulnerable", () => {
  assert.equal(
    classifyRegression("CONFIRMED", "CONFIRMED"),
    "STILL_VULNERABLE",
  );
});

test("execution errors never become safe", () => {
  assert.equal(classifyRegression("ERROR", "BLOCKED"), "UNVERIFIED");
});

test("all sixteen execution verdict combinations follow the fail-closed matrix", () => {
  const verdicts = [
    "CONFIRMED",
    "BLOCKED",
    "UNVERIFIED",
    "ERROR",
  ] as const satisfies readonly ExecutionResult["verdict"][];
  const expected = {
    CONFIRMED: {
      CONFIRMED: "STILL_VULNERABLE",
      BLOCKED: "FIXED",
      UNVERIFIED: "UNVERIFIED",
      ERROR: "UNVERIFIED",
    },
    BLOCKED: {
      CONFIRMED: "NOT_REPRODUCED",
      BLOCKED: "NOT_REPRODUCED",
      UNVERIFIED: "UNVERIFIED",
      ERROR: "UNVERIFIED",
    },
    UNVERIFIED: {
      CONFIRMED: "UNVERIFIED",
      BLOCKED: "UNVERIFIED",
      UNVERIFIED: "UNVERIFIED",
      ERROR: "UNVERIFIED",
    },
    ERROR: {
      CONFIRMED: "UNVERIFIED",
      BLOCKED: "UNVERIFIED",
      UNVERIFIED: "UNVERIFIED",
      ERROR: "UNVERIFIED",
    },
  } as const;

  let combinations = 0;
  for (const before of verdicts) {
    for (const after of verdicts) {
      assert.equal(
        classifyRegression(before, after),
        expected[before][after],
        `${before} -> ${after}`,
      );
      combinations += 1;
    }
  }
  assert.equal(combinations, 16);
});

test("unknown runtime verdicts fail closed without throwing", () => {
  const classifyLive = classifyRegression as (
    before: unknown,
    after: unknown,
  ) => ReturnType<typeof classifyRegression>;

  for (const [before, after] of [
    ["UNKNOWN", "BLOCKED"],
    ["CONFIRMED", "UNKNOWN"],
    [null, "BLOCKED"],
    [{ verdict: "CONFIRMED" }, "BLOCKED"],
  ] as const) {
    assert.doesNotThrow(() => classifyLive(before, after));
    assert.equal(classifyLive(before, after), "UNVERIFIED");
  }
});
