import { Buffer } from "node:buffer";

import {
  analysisPlanSchema,
  executionResultSchema,
  JSON_MAX_ARRAY_LENGTH,
  JSON_MAX_DEPTH,
  JSON_MAX_RECORD_KEYS,
  JSON_MAX_STRING_LENGTH,
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
  /^(?:auth\.json|credentials\.json|\.env[A-Za-z0-9._-]*|id_(?:rsa|dsa|ecdsa|ed25519)|private[-_.]?key(?:\.[A-Za-z0-9_-]+)?|[^/\\\s"'`]+\.(?:pem|key|p12|pfx))$/i;
// Repo-relative source filenames keep security-language stems allowed (private-key.ts).
const SOURCE_FILE_BASENAME_PATTERN =
  /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|cs|swift|scala|php|c|cc|cpp|h|hpp|md)$/i;
const SECRET_FILE_BASENAME_PATTERN =
  /^(?:(?:api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|oauth[-_]?token|credentials?|password|passwd|secret|client[-_]?secret)(?:\.(?:json|txt|ya?ml|env|ini|conf|config|properties))?|token\.(?:json|txt|ya?ml|env|ini|conf|config|properties))$/i;
const SENSITIVE_REVIEWED_FILE_BASENAME_PATTERN =
  /^(?:auth\.json|credentials\.json|\.env[A-Za-z0-9._-]*|id_(?:rsa|dsa|ecdsa|ed25519)|private[-_.]?key|[^/\\\s"'`]+\.(?:pem|key|p12|pfx))$/i;
const SENSITIVE_PATH_TOKEN_PATTERN =
  /(?:^|[/\\])(?:id_(?:rsa|dsa|ecdsa|ed25519)|private[-_.]?key)(?:$|[/\\\s"'`()\[\]{},;<>])/i;
const DRIVE_LETTER_PATH_PATTERN =
  /(?:^|[^A-Za-z0-9_.-])[A-Za-z]:[\\/][^\s"'`<>]*/;
const UNC_PATH_PATTERN = /(?:^|[\s"'`([{=:>,;])\\\\[^\\\s]+\\[^\\\s]+/;
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
  /(?:^|[^A-Za-z0-9_.-])~\/(?:\.ssh|\.aws|\.config|\.codex)\/(?:[^\s"'`<>]*)/i,
  /(?:^|[^A-Za-z0-9_.-])(?:HOME|USERPROFILE)\s*\/\s*(?:\.ssh|\.aws|\.config|\.codex)\/(?:[^\s"'`<>]*)/i,
  DRIVE_LETTER_PATH_PATTERN,
  UNC_PATH_PATTERN,
] as const;
// Contract schemas cap JSON at depth 8, while report wrappers add at most eight levels.
const MAX_REPORT_JSON_DEPTH = JSON_MAX_DEPTH + 8;
// Every JSON node consumes at least one byte inside the existing report byte cap.
const MAX_REPORT_JSON_NODES = REPORT_MAX_BYTES;
const MAX_REPORT_WRAPPER_ENTRIES = 64;
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

type SnapshotContext = {
  arrayLimit?: number;
  jsonValue: boolean;
};

const childSnapshotContext = (
  key: string,
  parentIsJsonValue: boolean,
): SnapshotContext => {
  if (key === "vulnerableResults" || key === "patchedResults") {
    return { arrayLimit: 50, jsonValue: false };
  }
  if (key === "reviewedFiles" || key === "hypotheses") {
    return { arrayLimit: MAX_REPORT_WRAPPER_ENTRIES, jsonValue: false };
  }
  if (key === "evidence" || key === "tests" || key === "assertions") {
    return { arrayLimit: MAX_REPORT_WRAPPER_ENTRIES, jsonValue: false };
  }
  if (
    parentIsJsonValue ||
    key === "body" ||
    key === "expected" ||
    key === "actual" ||
    key === "equals"
  ) {
    return { jsonValue: true };
  }
  return { jsonValue: false };
};

const maxContainerEntries = (context: SnapshotContext): number =>
  context.arrayLimit ??
  (context.jsonValue ? JSON_MAX_ARRAY_LENGTH : MAX_REPORT_WRAPPER_ENTRIES);

const snapshotJsonOrigin = (root: unknown): JsonSnapshot => {
  const ancestors = new Set<object>();
  let visited = 0;
  let accountedBytes = 0;

  const accountBytes = (bytes: number): void => {
    accountedBytes += bytes;
    if (accountedBytes > REPORT_MAX_BYTES) return rejectReport();
  };

  const visit = (
    value: unknown,
    depth: number,
    context: SnapshotContext,
  ): JsonSnapshot => {
    visited += 1;
    if (visited > MAX_REPORT_JSON_NODES || depth > MAX_REPORT_JSON_DEPTH) {
      return rejectReport();
    }
    if (value === null) {
      accountBytes(4);
      return value;
    }
    if (typeof value === "string") {
      if (
        context.jsonValue &&
        value.length > JSON_MAX_STRING_LENGTH
      ) {
        return rejectReport();
      }
      accountBytes(Buffer.byteLength(value, "utf8") + 2);
      return value;
    }
    if (typeof value === "boolean") {
      accountBytes(value ? 4 : 5);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return rejectReport();
      accountBytes(String(value).length);
      return value;
    }
    if (typeof value !== "object") return rejectReport();
    if (ancestors.has(value)) return rejectReport();

    const prototype = Object.getPrototypeOf(value);
    const isArray = Array.isArray(value);
    if (isArray) {
      if (prototype !== Array.prototype) return rejectReport();
    } else if (prototype !== Object.prototype) {
      return rejectReport();
    }

    if (isArray) {
      // Capture once: a single ownKeys pass with one descriptor read per key.
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownKeys = Reflect.ownKeys(descriptors);
      const lengthDescriptor = (
        descriptors as Record<string, PropertyDescriptor | undefined>
      )["length"];
      if (
        ownKeys.some((key) => typeof key === "symbol") ||
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
      if (logicalLength > maxContainerEntries(context)) return rejectReport();
      if (ownKeys.length !== logicalLength + 1 || ownKeys.at(-1) !== "length") {
        return rejectReport();
      }
      accountBytes(2 + Math.max(0, logicalLength - 1));
      ancestors.add(value);
      try {
        const snapshot: JsonSnapshot[] = [];
        for (let index = 0; index < logicalLength; index += 1) {
          const key = String(index);
          if (ownKeys[index] !== key) return rejectReport();
          const descriptor = descriptors[key];
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !Object.hasOwn(descriptor, "value")
          ) {
            return rejectReport();
          }
          snapshot.push(visit(descriptor.value, depth + 1, context));
        }
        return snapshot;
      } finally {
        ancestors.delete(value);
      }
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key === "symbol")) return rejectReport();
    if (
      ownKeys.length >
      (context.jsonValue ? JSON_MAX_RECORD_KEYS : MAX_REPORT_WRAPPER_ENTRIES)
    ) {
      return rejectReport();
    }
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

    accountBytes(2 + Math.max(0, ownKeys.length - 1));
    ancestors.add(value);
    try {
      const snapshot: { [key: string]: JsonSnapshot } = {};
      for (const key of ownKeys as string[]) {
        const descriptor = descriptors[key];
        if (
          descriptor === undefined ||
          !Object.hasOwn(descriptor, "value")
        ) {
          return rejectReport();
        }
        if (context.jsonValue && key.length > 256) {
          return rejectReport();
        }
        accountBytes(Buffer.byteLength(key, "utf8") + 3);
        Object.defineProperty(snapshot, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: visit(
            descriptor.value,
            depth + 1,
            childSnapshotContext(key, context.jsonValue),
          ),
        });
      }
      return snapshot;
    } finally {
      ancestors.delete(value);
    }
  };

  return visit(root, 0, { jsonValue: false });
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
    if (basename === undefined || !basename.includes(".")) return false;
    // Repo-relative source filenames such as private-key.ts stay allowed.
    if (SOURCE_FILE_BASENAME_PATTERN.test(basename)) return false;
    return (
      SENSITIVE_PATH_BASENAME_PATTERN.test(basename) ||
      SECRET_FILE_BASENAME_PATTERN.test(basename)
    );
  });

const hasAbsolutePosixHostPath = (value: string): boolean => {
  const pathTokens = value.match(/(?:^|[\s"'`([{=:>,;])\/{1,2}[^\s"'`<>]*/g);
  if (pathTokens === null) return false;
  return pathTokens.some((token) => {
    const path = token.trimStart();
    return !path.startsWith("/api/");
  });
};

// Host filesystem locations: POSIX absolutes, drive-letter paths and UNC shares.
const containsHostPath = (value: string): boolean =>
  hasAbsolutePosixHostPath(value) ||
  DRIVE_LETTER_PATH_PATTERN.test(value) ||
  UNC_PATH_PATTERN.test(value);

const containsSensitiveString = (value: string): boolean => {
  if (containsHostPath(value)) return true;
  if (SENSITIVE_PATH_TOKEN_PATTERN.test(value)) return true;
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
    !SENSITIVE_REVIEWED_FILE_BASENAME_PATTERN.test(baseName)
  );
};

const sensitiveKeyWords = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());

const SENSITIVE_KEY_WORDS = new Set([
  "authorization",
  "auth",
  "oauth",
  "password",
  "passwd",
  "secret",
  "credential",
  "prompt",
  "token",
  "environment",
  "env",
  "error",
]);

const SENSITIVE_COMPACT_KEY_FAMILIES = [
  "accesskey",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "oauthtoken",
  "githubtoken",
  "clientsecret",
  "privatekey",
  "apikey",
  "token",
  "rawerror",
  "rawprompt",
  "repositorypath",
  "repopath",
  "environment",
  "credential",
  "password",
  "prompt",
  "secret",
  "error",
] as const;

const SAFE_COMPACT_KEY_FAMILIES = [
  "tokenizer",
  "passwordless",
  "credentialing",
  "secretariat",
  "standarderror",
  "environmental",
] as const;

const pluralStem = (word: string): string =>
  word.endsWith("s") && word !== "access" ? word.slice(0, -1) : word;

// Family stems that stay sensitive everywhere except inside these exact sequences.
const SAFE_KEY_SEQUENCES: readonly (readonly string[])[] = [
  ["token", "count"],
  ["standard", "error"],
];

const hasSequenceAt = (
  words: readonly string[],
  index: number,
  sequence: readonly string[],
): boolean => sequence.every((word, offset) => words[index + offset] === word);

const withoutSafeKeySequences = (words: readonly string[]): string[] => {
  const remaining = [...words];
  for (const sequence of SAFE_KEY_SEQUENCES) {
    for (
      let index = 0;
      index <= remaining.length - sequence.length;
      index += 1
    ) {
      if (!hasSequenceAt(remaining, index, sequence)) continue;
      remaining.splice(index, sequence.length);
      index = -1;
    }
  }
  return remaining;
};

const hasWordSequence = (
  words: readonly string[],
  sequence: readonly string[],
): boolean =>
  words.some((_, index) => hasSequenceAt(words, index, sequence));

const isSensitiveDurableKey = (key: string): boolean => {
  if (containsHostPath(key)) return true;
  if (containsSensitivePathBasename(key)) return true;
  const words = withoutSafeKeySequences(sensitiveKeyWords(key).map(pluralStem));
  if (words.length === 0) return false;
  if (words.some((word) => SENSITIVE_KEY_WORDS.has(word))) return true;

  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const compact = SAFE_COMPACT_KEY_FAMILIES.reduce(
    (candidate, family) => candidate.replaceAll(family, ""),
    normalized,
  );
  return (
    SENSITIVE_COMPACT_KEY_FAMILIES.some((family) => compact.includes(family)) ||
    hasWordSequence(words, ["api", "key"]) ||
    hasWordSequence(words, ["access", "key"]) ||
    hasWordSequence(words, ["private", "key"]) ||
    hasWordSequence(words, ["repo", "path"]) ||
    hasWordSequence(words, ["repository", "path"])
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
