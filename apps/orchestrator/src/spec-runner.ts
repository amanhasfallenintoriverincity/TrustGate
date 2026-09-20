import {
  executionResultSchema,
  jsonValueSchema,
  type ExecutionResult,
  type JsonValue,
  type TestSpec,
} from "@trustgate/contracts";

export type HttpResult = { status: number; json: JsonValue };

export type SendRequest = (
  path: string,
  init: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    headers: Record<string, string>;
    body?: JsonValue;
  },
) => Promise<HttpResult>;

type Evidence = ExecutionResult["evidence"];
type PathResult =
  | { ok: true; value: JsonValue }
  | { ok: false };

const ACTOR_HEADERS = { "x-actor-id": "alice" } as const;
const STATE_PATH = "/__state/alice";
const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const resultFor = (
  spec: TestSpec,
  verdict: ExecutionResult["verdict"],
  executed: boolean,
  evidence: Evidence,
): ExecutionResult =>
  executionResultSchema.parse({
    runId: `spec-${spec.id}`,
    hypothesisId: spec.id,
    verdict,
    executed,
    evidence,
  });

const resolveJsonPath = (root: JsonValue, path: string): PathResult => {
  if (path === "$") return { ok: true, value: root };
  if (!path.startsWith("$.")) return { ok: false };

  let current = root;
  for (const segment of path.slice(2).split(".")) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) return { ok: false };

    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return { ok: false };
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || !Object.hasOwn(current, index)) {
        return { ok: false };
      }
      current = current[index]!;
      continue;
    }

    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, segment)
    ) {
      return { ok: false };
    }
    current = current[segment]!;
  }

  return { ok: true, value: current };
};

const jsonEquals = (left: JsonValue, right: JsonValue): boolean => {
  if (left === right) return true;
  if (left === null || right === null) return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEquals(value, right[index]!))
    );
  }

  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && jsonEquals(left[key]!, right[key]!),
    )
  );
};

const numericStateValue = (state: HttpResult, key: string): number | undefined => {
  if (
    state.status !== 200 ||
    state.json === null ||
    Array.isArray(state.json) ||
    typeof state.json !== "object" ||
    !Object.hasOwn(state.json, key)
  ) {
    return undefined;
  }
  const value = state.json[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const invalidStateEvidence = (): Evidence => [
  {
    kind: "invalid-state",
    expected: "finite-state-numbers",
    actual: "invalid-state-shape",
  },
];

const invalidStateDeltaEvidence = (): Evidence => [
  {
    kind: "invalid-state-delta",
    expected: "finite-number",
    actual: "invalid-equals",
  },
];

const evaluationErrorEvidence = (
  expected: "assertion-evaluated" | "bounded-json-values" | "finite-state-delta",
  actual: "assertion-failed" | "unrepresentable-mismatch" | "unrepresentable-state-delta",
): Evidence => [
  {
    kind: "evaluation-error",
    expected,
    actual,
  },
];

const isEvidenceJsonValue = (value: JsonValue): boolean =>
  jsonValueSchema.safeParse(value).success;

const stateHasKeys = (
  state: HttpResult,
  keys: ReadonlyArray<"balance" | "inventoryCount">,
): boolean => keys.every((key) => numericStateValue(state, key) !== undefined);

const transportError = (spec: TestSpec): ExecutionResult =>
  resultFor(spec, "ERROR", false, [
    {
      kind: "transport-error",
      expected: "request-completed",
      actual: "request-failed",
    },
  ]);

const unsupportedPathError = (spec: TestSpec): ExecutionResult =>
  resultFor(spec, "ERROR", false, [
    {
      kind: "unsupported-json-path",
      expected: "supported-own-json-path",
      actual: "unresolved-json-path",
    },
  ]);

const hasForbiddenPathSegment = (spec: TestSpec): boolean =>
  spec.assertions.some(
    (assertion) =>
      assertion.kind === "json-equals" &&
      assertion.path
        .slice(assertion.path === "$" ? 1 : 2)
        .split(".")
        .some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment)),
  );

const isSupportedMethod = (
  method: TestSpec["request"]["method"],
): method is "GET" | "POST" | "PATCH" | "DELETE" =>
  method === "GET" ||
  method === "POST" ||
  method === "PATCH" ||
  method === "DELETE";

export const runTestSpec = async (
  spec: TestSpec,
  send: SendRequest,
): Promise<ExecutionResult> => {
  if (hasForbiddenPathSegment(spec)) return unsupportedPathError(spec);
  if (!isSupportedMethod(spec.request.method)) {
    return resultFor(spec, "ERROR", false, [
      {
        kind: "unsupported-method",
        expected: "GET-POST-PATCH-DELETE",
        actual: "unsupported-method",
      },
    ]);
  }
  if (
    spec.assertions.some(
      (assertion) =>
        assertion.kind === "state-delta" &&
        assertion.key !== "balance" &&
        assertion.key !== "inventoryCount",
    )
  ) {
    return resultFor(spec, "ERROR", false, [
      {
        kind: "unsupported-state-key",
        expected: "balance-or-inventoryCount",
        actual: "unsupported-state-key",
      },
    ]);
  }
  if (
    spec.assertions.some(
      (assertion) =>
        assertion.kind === "state-delta" &&
        (typeof assertion.equals !== "number" || !Number.isFinite(assertion.equals)),
    )
  ) {
    return resultFor(spec, "ERROR", false, invalidStateDeltaEvidence());
  }
  const stateKeys = ["balance", "inventoryCount"] as const;
  let before: HttpResult;
  try {
    before = await send(STATE_PATH, {
      method: "GET",
      headers: { ...ACTOR_HEADERS },
    });
  } catch {
    return transportError(spec);
  }
  if (!stateHasKeys(before, stateKeys)) {
    return resultFor(spec, "ERROR", false, invalidStateEvidence());
  }

  let response: HttpResult;
  try {
    response = await send(spec.request.path, {
      method: spec.request.method,
      headers: { ...ACTOR_HEADERS },
      ...(spec.request.body === undefined ? {} : { body: spec.request.body }),
    });
  } catch {
    return transportError(spec);
  }

  const responseEvidence: Evidence = [];
  let responseEvaluationError: "unsupported-path" | "unrepresentable" | "evaluation" | undefined;
  try {
    for (const assertion of spec.assertions) {
      if (assertion.kind === "status") {
        if (response.status !== assertion.equals) {
          if (
            !isEvidenceJsonValue(assertion.equals) ||
            !isEvidenceJsonValue(response.status)
          ) {
            responseEvaluationError = "unrepresentable";
            break;
          }
          responseEvidence.push({
            kind: "status",
            expected: assertion.equals,
            actual: response.status,
          });
        }
        continue;
      }

      if (assertion.kind === "json-equals") {
        const resolved = resolveJsonPath(response.json, assertion.path);
        if (!resolved.ok) {
          responseEvaluationError = "unsupported-path";
          break;
        }
        if (!jsonEquals(resolved.value, assertion.equals)) {
          if (
            !isEvidenceJsonValue(assertion.equals) ||
            !isEvidenceJsonValue(resolved.value)
          ) {
            responseEvaluationError = "unrepresentable";
            break;
          }
          responseEvidence.push({
            kind: "json-equals",
            expected: assertion.equals,
            actual: resolved.value,
          });
        }
      }
    }
  } catch {
    responseEvaluationError = "evaluation";
  }
  if (responseEvaluationError === "unsupported-path") {
    return unsupportedPathError(spec);
  }
  if (responseEvaluationError === "evaluation") {
    return resultFor(
      spec,
      "ERROR",
      false,
      evaluationErrorEvidence("assertion-evaluated", "assertion-failed"),
    );
  }

  let after: HttpResult;
  try {
    after = await send(STATE_PATH, {
      method: "GET",
      headers: { ...ACTOR_HEADERS },
    });
  } catch {
    return transportError(spec);
  }
  if (!stateHasKeys(after, stateKeys)) {
    return resultFor(spec, "ERROR", false, invalidStateEvidence());
  }
  if (responseEvaluationError === "unrepresentable") {
    return resultFor(
      spec,
      "ERROR",
      false,
      evaluationErrorEvidence("bounded-json-values", "unrepresentable-mismatch"),
    );
  }

  const evidence = [...responseEvidence];
  try {
    for (const assertion of spec.assertions) {
      if (assertion.kind !== "state-delta") continue;
      const beforeValue = numericStateValue(before, assertion.key)!;
      const afterValue = numericStateValue(after, assertion.key)!;
      const actual = afterValue - beforeValue;
      if (!Number.isFinite(actual)) {
        return resultFor(
          spec,
          "ERROR",
          false,
          evaluationErrorEvidence("finite-state-delta", "unrepresentable-state-delta"),
        );
      }
      if (!jsonEquals(actual, assertion.equals)) {
        if (
          !isEvidenceJsonValue(assertion.equals) ||
          !isEvidenceJsonValue(actual)
        ) {
          return resultFor(
            spec,
            "ERROR",
            false,
            evaluationErrorEvidence("bounded-json-values", "unrepresentable-mismatch"),
          );
        }
        evidence.push({
          kind: "state-delta",
          expected: assertion.equals,
          actual,
        });
      }
    }
  } catch {
    return resultFor(spec, "ERROR", false, [
      {
        kind: "evaluation-error",
        expected: "assertion-evaluated",
        actual: "assertion-failed",
      },
    ]);
  }

  return resultFor(
    spec,
    evidence.length === 0 ? "BLOCKED" : "CONFIRMED",
    true,
    evidence,
  );
};
