import type { ExecutionResult } from "@trustgate/contracts";

export type RegressionVerdict =
  | "FIXED"
  | "STILL_VULNERABLE"
  | "NOT_REPRODUCED"
  | "UNVERIFIED";

const EXECUTION_VERDICTS = new Set<unknown>([
  "CONFIRMED",
  "BLOCKED",
  "UNVERIFIED",
  "ERROR",
]);

export const classifyRegression = (
  before: ExecutionResult["verdict"],
  after: ExecutionResult["verdict"],
): RegressionVerdict => {
  if (!EXECUTION_VERDICTS.has(before) || !EXECUTION_VERDICTS.has(after)) {
    return "UNVERIFIED";
  }
  if (
    before === "ERROR" ||
    after === "ERROR" ||
    before === "UNVERIFIED" ||
    after === "UNVERIFIED"
  ) {
    return "UNVERIFIED";
  }
  if (before === "CONFIRMED" && after === "BLOCKED") return "FIXED";
  if (before === "CONFIRMED" && after === "CONFIRMED") {
    return "STILL_VULNERABLE";
  }
  return "NOT_REPRODUCED";
};
