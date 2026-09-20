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

/** Internal JSON-origin data; non-JSON JavaScript values are rejected, not normalized. */
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
const SENSITIVE_PATH_BASENAME_PATTERN =
  /^(?:auth\.json|\.env[A-Za-z0-9._-]*|id_(?:rsa|dsa|ecdsa|ed25519)|private[-_.]?key(?:\.[A-Za-z0-9_-]+)?|[^/\\\s"'`]+\.(?:pem|key|p12|pfx))$/i;
const SECRET_FILE_BASENAME_PATTERN =
  /^(?:(?:api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|oauth[-_]?token|credentials?|password|passwd|secret|client[-_]?secret)(?:\.(?:json|txt|ya?ml|env|ini|conf|config|properties))?|token\.(?:json|txt|ya?ml|env|ini|conf|config|properties))$/i;
const SENSITIVE_STRING_PATTERNS = [
  /\braw[-_ ]?(?:(?:system|user|developer)[-_ ]?)?(?:prompt|error)(?:[-_ ]?(?:detail|message|stack))?(?:[-_ ]?marker)?\b/i,
  /\bauthorization\s*[:=]\s*\S+/i,
  /\bbearer\s+(?!(?:authentication|authorization|scheme|header)\b)\S+/i,
  /\b(?:(?:[A-Za-z0-9]+[_-])*api[_-]?key|x[-_]?api[-_]?key)\s*[:=]\s*\S+/i,
  /\b(?:(?:github|session|access|refresh|oauth)[_-]?token|token)s?\s*[:=]\s*\S+/i,
  /\b(?:(?:db[_-]?)?password|passwd)s?\s*[:=]\s*\S+/i,
  /\b(?:client[_-]?secret|secret)s?\s*[:=]\s*\S+/i,
  /\bcredentials?\s*[:=]\s*\S+/i,
  /\b(?:api[-_ ]?key|token|password|credential|secret)[-_ ]?marker\b/i,
  /\b(?:authorization|bearer|api[-_ ]?key|session[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token|oauth[-_ ]?token|token|password|passwd|client[-_ ]?secret|secret|credential|aws[_-]?secret[_-]?access[_-]?key)s?\s*[:=]\s*\S+/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/i,
  /\b(?:gh[opsur]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/i,
  /\b(?:glpat-|npm_|pypi-|hf_|xai-|sk_live_|rk_live_)[A-Za-z0-9_-]{12,}\b/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:^|[^A-Za-z0-9_./~-])\/(?:home|Users|root|tmp|var|opt|etc)\/(?:[^\s"'`<>]*)/i,
  /(?:^|[^A-Za-z0-9_.-])~\/(?:\.ssh|\.aws|\.config|\.codex)\/(?:[^\s"'`<>]*)/i,
  /(?:^|[^A-Za-z0-9_.-])(?:HOME|USERPROFILE)\s*\/\s*(?:\.ssh|\.aws|\.config|\.codex)\/(?:[^\s"'`<>]*)/i,
  /(?:^|[^A-Za-z0-9_.-])[A-Za-z]:[\\/][^\s"'`<>]*/,
  /(?:^|[\s"'`([{=:>,;])\\\\[^\\\s]+\\[^\\\s]+/,
] as const;
// Contract schemas cap JSON at depth 8, while report wrappers add at most eight levels.
const MAX_REPORT_JSON_DEPTH = JSON_MAX_DEPTH + 8;
// Every JSON node consumes at least one byte inside the existing report byte cap.
const MAX_REPORT_JSON_NODES = REPORT_MAX_BYTES;
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

type JsonSnapshot =
  | string
  | number
  | boolean
  | null
  | JsonSnapshot[]
  | { [key: string]: JsonSnapshot };

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const snapshotJsonOrigin = (root: unknown): JsonSnapshot => {
  const ancestors = new Set<object>();
  let visited = 0;

  const visit = (value: unknown, depth: number): JsonSnapshot => {
    visited += 1;
    if (visited > MAX_REPORT_JSON_NODES || depth > MAX_REPORT_JSON_DEPTH) {
      return rejectReport();
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : rejectReport();
    }
    if (typeof value !== "object") return rejectReport();
    if (ancestors.has(value)) return rejectReport();

    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return rejectReport();
    } else if (prototype !== Object.prototype) {
      return rejectReport();
    }

    const isArray = Array.isArray(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key === "symbol")) return rejectReport();
    if (
      ownKeys.some((key) => {
        if (typeof key !== "string") return true;
        if (
          key === "__proto__" ||
          key === "prototype" ||
          key === "constructor" ||
          key === "toJSON"
        ) {
          return true;
        }
        if (isArray && key === "length") return false;
        const descriptor = descriptors[key];
        return (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        );
      })
    ) {
      return rejectReport();
    }

    ancestors.add(value);
    try {
      if (isArray) {
        const lengthDescriptor = descriptors.length;
        if (
          lengthDescriptor === undefined ||
          !Object.hasOwn(lengthDescriptor, "value") ||
          lengthDescriptor.enumerable ||
          lengthDescriptor.configurable ||
          typeof lengthDescriptor.value !== "number" ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0 ||
          lengthDescriptor.value > 0xffff_ffff
        ) {
          return rejectReport();
        }
        const logicalLength = lengthDescriptor.value;
        if (
          ownKeys.length !== logicalLength + 1 ||
          ownKeys.at(-1) !== "length"
        ) {
          return rejectReport();
        }
        const snapshot: JsonSnapshot[] = [];
        for (let index = 0; index < logicalLength; index += 1) {
          const key = String(index);
          if (ownKeys[index] !== key) return rejectReport();
          const descriptor = descriptors[key];
          if (
            descriptor === undefined ||
            !Object.hasOwn(descriptor, "value")
          ) {
            return rejectReport();
          }
          snapshot.push(visit(descriptor.value, depth + 1));
        }
        return snapshot;
      }

      const snapshot: { [key: string]: JsonSnapshot } = {};
      for (const key of ownKeys as string[]) {
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !Object.hasOwn(descriptor, "value")
        ) {
          return rejectReport();
        }
        Object.defineProperty(snapshot, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: visit(descriptor.value, depth + 1),
        });
      }
      return snapshot;
    } finally {
      ancestors.delete(value);
    }
  };

  return visit(root, 0);
};

const cloneJson = <Value>(value: Value): Value =>
  snapshotJsonOrigin(value) as Value;

const serializeJsonSnapshot = (value: JsonSnapshot): string => {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeJsonSnapshot).join(",")}]`;
  }
  return `{${Object.entries(value)
    .map(([key, child]) => `${JSON.stringify(key)}:${serializeJsonSnapshot(child)}`)
    .join(",")}}`;
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

const containsSensitivePathBasename = (value: string): boolean =>
  value.split(/[/\\]/).some((segment) => {
    const basename = segment.match(/^[^\s"'`()\[\]{},;<>]+/)?.[0];
    return (
      basename !== undefined && SENSITIVE_PATH_BASENAME_PATTERN.test(basename)
    );
  });

const containsSensitiveString = (value: string): boolean => {
  if (containsSensitivePathBasename(value)) return true;
  for (const pattern of SENSITIVE_STRING_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) return true;
  }
  return false;
};

const SENSITIVE_METADATA_PATTERN =
  /(?:^|[-_.])(?:authorization|api[-_]?key|token|password|passwd|secret|credential|credentials)(?:[-_.]|$)/i;

const validPublicMetadata = (value: unknown): value is string =>
  typeof value === "string" &&
  PUBLIC_ID_PATTERN.test(value) &&
  !SENSITIVE_METADATA_PATTERN.test(value) &&
  !containsSensitiveString(value);

const validReviewedFile = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.includes("\\") ||
    !RELATIVE_REPO_PATH_PATTERN.test(value)
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
    !SENSITIVE_PATH_BASENAME_PATTERN.test(baseName)
  );
};

const sensitiveKeyWords = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());

const hasAdjacentWords = (
  words: readonly string[],
  first: string,
  second: string,
): boolean =>
  words.some((word, index) => word === first && words[index + 1] === second);

const SENSITIVE_KEY_FAMILIES = [
  "authorizationheader",
  "authorization",
  "openaikey",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "oauthtoken",
  "githubtoken",
  "token",
  "clientsecret",
  "secret",
  "credentials",
  "credential",
  "password",
  "passwd",
  "developerprompt",
  "systemprompt",
  "userprompt",
  "rawprompt",
  "prompt",
  "authpath",
  "auth",
  "oauthpath",
  "oauth",
  "repositorypath",
  "repopath",
  "privatekey",
  "rawerror",
  "errordetail",
  "errormessage",
  "errorstack",
  "error",
  "environmentname",
  "environmentvariables",
  "environment",
  "env",
  "accesskeyid",
  "secretaccesskey",
  "awssecretaccesskey",
] as const;

const SENSITIVE_KEY_QUALIFIERS = [
  "configurations",
  "configuration",
  "parameters",
  "parameter",
  "materials",
  "material",
  "variables",
  "variable",
  "metadata",
  "contents",
  "content",
  "payloads",
  "payload",
  "values",
  "value",
  "configs",
  "config",
  "inputs",
  "input",
  "paths",
  "path",
  "texts",
  "text",
  "data",
  "info",
] as const;

const hasSensitiveFamily = (normalized: string): boolean =>
  SENSITIVE_KEY_FAMILIES.some(
    (family) =>
      normalized.endsWith(family) || normalized.endsWith(`${family}s`),
  );

const isSensitiveDurableKey = (key: string): boolean => {
  const words = sensitiveKeyWords(key);
  const last = words.at(-1);
  if (last === undefined) return false;

  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  let candidate = normalized;
  while (candidate.length > 0) {
    if (hasSensitiveFamily(candidate)) return true;
    const qualifier = SENSITIVE_KEY_QUALIFIERS.find((suffix) =>
      candidate.endsWith(suffix),
    );
    if (qualifier === undefined) break;
    candidate = candidate.slice(0, -qualifier.length);
  }
  return (
    normalized === "analysisprompt" ||
    normalized === "dbpassword" ||
    normalized === "secretariattoken" ||
    hasAdjacentWords(words, "api", "key") ||
    hasAdjacentWords(words, "private", "key") ||
    hasAdjacentWords(words, "client", "secret") ||
    hasAdjacentWords(words, "authorization", "header") ||
    hasAdjacentWords(words, "auth", "path") ||
    hasAdjacentWords(words, "oauth", "path") ||
    hasAdjacentWords(words, "repo", "path") ||
    hasAdjacentWords(words, "repository", "path") ||
    hasAdjacentWords(words, "error", "detail") ||
    hasAdjacentWords(words, "error", "message") ||
    hasAdjacentWords(words, "error", "stack") ||
    hasAdjacentWords(words, "raw", "prompt") ||
    hasAdjacentWords(words, "raw", "error") ||
    hasAdjacentWords(words, "system", "prompt") ||
    hasAdjacentWords(words, "user", "prompt") ||
    hasAdjacentWords(words, "developer", "prompt") ||
    hasAdjacentWords(words, "session", "token") ||
    hasAdjacentWords(words, "access", "token") ||
    hasAdjacentWords(words, "refresh", "token") ||
    hasAdjacentWords(words, "oauth", "token") ||
    hasAdjacentWords(words, "environment", "variables")
  );
};

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
      visited > MAX_REPORT_JSON_NODES ||
      entry.depth > MAX_REPORT_JSON_DEPTH
    ) {
      return true;
    }

    if (typeof entry.value === "string") {
      if (containsSensitiveString(entry.value)) return true;
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
      if (entry.depth === MAX_REPORT_JSON_DEPTH) return true;
      for (const value of entry.value) {
        pending.push({ value, depth: entry.depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(entry.value)) return true;
    if (entry.depth === MAX_REPORT_JSON_DEPTH) return true;
    for (const [key, value] of Object.entries(entry.value)) {
      if (isSensitiveDurableKey(key)) return true;
      pending.push({ value, depth: entry.depth + 1 });
    }
  }

  return false;
};

const parseInputSnapshot = (input: ReportInput): ReportInput => {
  try {
    const snapshotValue = snapshotJsonOrigin(input);
    const serializedInput = serializeJsonSnapshot(snapshotValue);
    if (Buffer.byteLength(serializedInput, "utf8") > REPORT_MAX_BYTES) {
      return rejectReport();
    }
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
    if (containsSensitiveDurableValue(snapshotValue)) {
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
    const reviewedFiles = new Set(snapshot.reviewedFiles);
    const hypothesisIds = new Set<string>();
    const testIds = new Set<string>();
    for (const hypothesis of hypotheses) {
      if (hypothesisIds.has(hypothesis.id)) return rejectReport();
      hypothesisIds.add(hypothesis.id);
      for (const evidence of hypothesis.evidence) {
        if (
          !validReviewedFile(evidence.file) ||
          !reviewedFiles.has(evidence.file)
        ) {
          return rejectReport();
        }
      }
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
    const reportSnapshot = snapshotJsonOrigin(report);
    if (containsSensitiveDurableValue(reportSnapshot)) {
      return rejectReport();
    }
    const serialized = serializeJsonSnapshot(reportSnapshot);
    if (Buffer.byteLength(serialized, "utf8") > REPORT_MAX_BYTES) {
      return rejectReport();
    }
    return JSON.parse(serialized) as RunReport;
  } catch {
    return rejectReport();
  }
};
