import { Buffer } from "node:buffer";

import {
  analysisPlanSchema,
  executionResultSchema,
  JSON_MAX_DEPTH,
  type AnalysisPlan,
  type ExecutionResult,
} from "@trustgate/contracts";

import {
  classifyRegression,
  type RegressionVerdict,
} from "./verdict.js";

export const REPORT_MAX_BYTES = 1_048_576;
export const REPORT_MAX_DURATION_MS = 86_400_000;

export type ReportDurations = {
  totalMs: number;
  ocrMs: number;
  planningMs: number;
  vulnerableMs: number;
  patchedMs: number;
};

export type ReportInput = {
  runId: string;
  provider: string;
  model: string;
  reviewedFiles: string[];
  hypotheses: AnalysisPlan["hypotheses"];
  vulnerableResults: ExecutionResult[];
  patchedResults: ExecutionResult[];
  durations: ReportDurations;
};

type Hypothesis = AnalysisPlan["hypotheses"][number];
type TestSpec = Hypothesis["tests"][number];

export type TestRegression = TestSpec & {
  vulnerableResult: ExecutionResult;
  patchedResult: ExecutionResult;
  regressionVerdict: RegressionVerdict;
};

export type HypothesisRegression = Omit<Hypothesis, "tests"> & {
  tests: TestRegression[];
  /** Aggregate precedence: UNVERIFIED > STILL_VULNERABLE > FIXED > NOT_REPRODUCED. */
  regressionVerdict: RegressionVerdict;
};

export type RunReport = {
  runId: string;
  provider: string;
  model: string;
  reviewedFiles: string[];
  hypotheses: HypothesisRegression[];
  vulnerableResults: ExecutionResult[];
  patchedResults: ExecutionResult[];
  /** Aggregate precedence: UNVERIFIED > STILL_VULNERABLE > FIXED > NOT_REPRODUCED. */
  regressionVerdict: RegressionVerdict;
  durations: ReportDurations;
};

type ExpectedIdentity = {
  hypothesisId: string;
  runId: string;
};

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const RELATIVE_REPO_PATH_PATTERN = /^(?!\/)(?!.*\/\/)[A-Za-z0-9._@+ -]+(?:\/[A-Za-z0-9._@+ -]+)*$/;
const SECRET_METADATA_PATTERN =
  /(?:authorization\s*:|bearer\s+|x-api-key|api[_-]?key|github[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|credential|\.codex(?:\/|\\)auth\.json|(?:^|[\/\\])\.env(?:[.\/\\]|$)|\bsecret\b)/i;
const SECRET_FILE_BASENAME_PATTERN = /^(?:\.env(?:\..*)?|auth\.json)$/i;
const SECRET_FILE_EXTENSION_PATTERN = /\.(?:pem|key)$/i;
const SENSITIVE_KEY_NAMES = new Set([
  "prompt",
  "systemprompt",
  "userprompt",
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "oauthpath",
  "authpath",
  "repopath",
  "env",
  "environment",
  "rawerror",
  "errordetail",
  "credential",
  "password",
  "secret",
  "githubtoken",
  "clientsecret",
  "privatekey",
]);
const SENSITIVE_STRING_PATTERN =
  /(?:raw[-_ ]?(?:prompt|error)(?:[-_ ]?marker)?|authorization\s*:\s*\S+|bearer\s+(?!(?:authentication|authorization|scheme|header)(?:\s|$))\S+|x-api-key\s*[:=]|api[_ -]?key(?:\s*[:=]|[-_ ]?marker\b)|(?:github|access|refresh)[_-]?token\s*[:=]|\btoken\s*[:=]|\btoken[-_ ]?marker\b|\bcredential\s*[:=]|\bcredential[-_ ]?marker\b|\bpassword\s*[:=]|\bpassword[-_ ]?marker\b|\bsecret\s*[:=]|\bsecret[-_ ]?marker\b|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\.codex(?:\/|\\)auth\.json|(?:^|[\/\\])\.env(?:[.\/\\]|$)|(?:^|[\/\\])[^\/\\]+\.(?:pem|key)$|^\/home\/|^\/Users\/|^[A-Za-z]:[\\/]|^\\\\)/i;
// Contract schemas cap JSON at depth 8, while report wrappers add at most eight levels.
const MAX_SENSITIVE_SCAN_DEPTH = JSON_MAX_DEPTH + 8;
// Every JSON node consumes at least one byte inside the existing report byte cap.
const MAX_SENSITIVE_SCAN_NODES = REPORT_MAX_BYTES;
const DURATION_KEYS = [
  "totalMs",
  "ocrMs",
  "planningMs",
  "vulnerableMs",
  "patchedMs",
] as const satisfies readonly (keyof ReportDurations)[];

const rejectReport = (): never => {
  throw new Error("run report rejected");
};

const cloneJson = <Value>(value: Value): Value => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return rejectReport();
  return JSON.parse(serialized) as Value;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactOwnKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
};

const validPublicMetadata = (value: unknown): value is string =>
  typeof value === "string" &&
  PUBLIC_ID_PATTERN.test(value) &&
  !SECRET_METADATA_PATTERN.test(value);

const validReviewedFile = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.includes("\\") ||
    !RELATIVE_REPO_PATH_PATTERN.test(value) ||
    SECRET_METADATA_PATTERN.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return false;
  }
  const baseName = segments.at(-1)!;
  return (
    !SECRET_FILE_BASENAME_PATTERN.test(baseName) &&
    !SECRET_FILE_EXTENSION_PATTERN.test(baseName) &&
    !/(?:^|[-_.])token(?:[-_.]|$)/i.test(baseName)
  );
};

const normalizedSensitiveKey = (key: string): string =>
  key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

const containsSensitiveDurableValue = (root: unknown): boolean => {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  let visited = 0;

  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) return true;
    visited += 1;
    if (
      visited > MAX_SENSITIVE_SCAN_NODES ||
      entry.depth > MAX_SENSITIVE_SCAN_DEPTH
    ) {
      return true;
    }

    if (typeof entry.value === "string") {
      if (SENSITIVE_STRING_PATTERN.test(entry.value)) return true;
      continue;
    }
    if (
      entry.value === null ||
      typeof entry.value === "number" ||
      typeof entry.value === "boolean"
    ) {
      continue;
    }
    if (Array.isArray(entry.value)) {
      if (entry.depth === MAX_SENSITIVE_SCAN_DEPTH) return true;
      for (const value of entry.value) {
        pending.push({ value, depth: entry.depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(entry.value)) return true;
    if (entry.depth === MAX_SENSITIVE_SCAN_DEPTH) return true;
    for (const [key, value] of Object.entries(entry.value)) {
      if (SENSITIVE_KEY_NAMES.has(normalizedSensitiveKey(key))) return true;
      pending.push({ value, depth: entry.depth + 1 });
    }
  }

  return false;
};

const parseInputSnapshot = (input: ReportInput): ReportInput => {
  try {
    if (!isPlainRecord(input)) return rejectReport();
    const serializedInput = JSON.stringify(input);
    if (Buffer.byteLength(serializedInput, "utf8") > REPORT_MAX_BYTES) {
      return rejectReport();
    }
    const snapshotValue: unknown = JSON.parse(serializedInput);
    if (
      !isPlainRecord(snapshotValue) ||
      !hasExactOwnKeys(snapshotValue, [
        "runId",
        "provider",
        "model",
        "reviewedFiles",
        "hypotheses",
        "vulnerableResults",
        "patchedResults",
        "durations",
      ])
    ) {
      return rejectReport();
    }
    const snapshot = snapshotValue as unknown as ReportInput;

    if (
      !validPublicMetadata(snapshot.runId) ||
      !validPublicMetadata(snapshot.provider) ||
      !validPublicMetadata(snapshot.model)
    ) {
      return rejectReport();
    }
    if (
      !Array.isArray(snapshot.reviewedFiles) ||
      snapshot.reviewedFiles.length < 1 ||
      snapshot.reviewedFiles.length > 64 ||
      !snapshot.reviewedFiles.every(validReviewedFile) ||
      new Set(snapshot.reviewedFiles).size !== snapshot.reviewedFiles.length
    ) {
      return rejectReport();
    }

    const hypotheses = analysisPlanSchema.parse({
      version: 1,
      hypotheses: snapshot.hypotheses,
    }).hypotheses;
    const hypothesisIds = new Set<string>();
    const testIds = new Set<string>();
    for (const hypothesis of hypotheses) {
      if (hypothesisIds.has(hypothesis.id)) return rejectReport();
      hypothesisIds.add(hypothesis.id);
      for (const spec of hypothesis.tests) {
        if (testIds.has(spec.id)) return rejectReport();
        testIds.add(spec.id);
      }
    }

    const vulnerableResults = executionResultSchema
      .array()
      .max(50)
      .parse(snapshot.vulnerableResults);
    const patchedResults = executionResultSchema
      .array()
      .max(50)
      .parse(snapshot.patchedResults);

    if (
      containsSensitiveDurableValue(hypotheses) ||
      containsSensitiveDurableValue(vulnerableResults) ||
      containsSensitiveDurableValue(patchedResults)
    ) {
      return rejectReport();
    }

    if (
      snapshot.durations === null ||
      typeof snapshot.durations !== "object" ||
      Array.isArray(snapshot.durations) ||
      Object.keys(snapshot.durations).length !== DURATION_KEYS.length
    ) {
      return rejectReport();
    }
    for (const key of DURATION_KEYS) {
      const duration = snapshot.durations[key];
      if (
        !Number.isSafeInteger(duration) ||
        duration < 0 ||
        duration > REPORT_MAX_DURATION_MS
      ) {
        return rejectReport();
      }
    }

    return {
      runId: snapshot.runId,
      provider: snapshot.provider,
      model: snapshot.model,
      reviewedFiles: snapshot.reviewedFiles,
      hypotheses,
      vulnerableResults,
      patchedResults,
      durations: snapshot.durations,
    };
  } catch {
    return rejectReport();
  }
};

const expectedIdentities = (
  hypotheses: AnalysisPlan["hypotheses"],
): ExpectedIdentity[] =>
  hypotheses.flatMap((hypothesis) =>
    hypothesis.tests.map((spec) => ({
      hypothesisId: hypothesis.id,
      runId: `spec-${spec.id}`,
    })),
  );

const assertExactResultIdentities = (
  results: readonly ExecutionResult[],
  expected: readonly ExpectedIdentity[],
): void => {
  if (results.length !== expected.length) return rejectReport();
  const seen = new Set<string>();
  results.forEach((result, index) => {
    const identity = `${result.hypothesisId}\u0000${result.runId}`;
    const expectedIdentity = expected[index];
    if (
      expectedIdentity === undefined ||
      result.hypothesisId !== expectedIdentity.hypothesisId ||
      result.runId !== expectedIdentity.runId ||
      seen.has(identity)
    ) {
      return rejectReport();
    }
    seen.add(identity);
  });
};

const aggregateRegression = (
  verdicts: readonly RegressionVerdict[],
): RegressionVerdict => {
  const precedence: readonly RegressionVerdict[] = [
    "UNVERIFIED",
    "STILL_VULNERABLE",
    "FIXED",
    "NOT_REPRODUCED",
  ];
  return precedence.find((verdict) => verdicts.includes(verdict)) ?? "UNVERIFIED";
};

export const createRunReport = (input: ReportInput): RunReport => {
  const snapshot = parseInputSnapshot(input);
  const expected = expectedIdentities(snapshot.hypotheses);
  assertExactResultIdentities(snapshot.vulnerableResults, expected);
  assertExactResultIdentities(snapshot.patchedResults, expected);

  let resultIndex = 0;
  const hypotheses = snapshot.hypotheses.map(
    (hypothesis): HypothesisRegression => {
      const tests = hypothesis.tests.map((spec): TestRegression => {
        const vulnerableResult = snapshot.vulnerableResults[resultIndex];
        const patchedResult = snapshot.patchedResults[resultIndex];
        if (vulnerableResult === undefined || patchedResult === undefined) {
          return rejectReport();
        }
        resultIndex += 1;
        return {
          ...cloneJson(spec),
          vulnerableResult: cloneJson(vulnerableResult),
          patchedResult: cloneJson(patchedResult),
          regressionVerdict: classifyRegression(
            vulnerableResult.verdict,
            patchedResult.verdict,
          ),
        };
      });
      const { tests: _tests, ...details } = cloneJson(hypothesis);
      return {
        ...details,
        tests,
        regressionVerdict: aggregateRegression(
          tests.map(({ regressionVerdict }) => regressionVerdict),
        ),
      };
    },
  );

  const report: RunReport = {
    runId: snapshot.runId,
    provider: snapshot.provider,
    model: snapshot.model,
    reviewedFiles: snapshot.reviewedFiles,
    hypotheses,
    vulnerableResults: snapshot.vulnerableResults,
    patchedResults: snapshot.patchedResults,
    regressionVerdict: aggregateRegression(
      hypotheses.map(({ regressionVerdict }) => regressionVerdict),
    ),
    durations: snapshot.durations,
  };

  try {
    const serialized = JSON.stringify(report);
    if (Buffer.byteLength(serialized, "utf8") > REPORT_MAX_BYTES) {
      return rejectReport();
    }
    return JSON.parse(serialized) as RunReport;
  } catch {
    return rejectReport();
  }
};
