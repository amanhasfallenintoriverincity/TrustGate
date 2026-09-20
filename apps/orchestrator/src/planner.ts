import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

import {
  analysisPlanSchema,
  parseContractJson,
  type AnalysisPlan,
} from "@trustgate/contracts";
import type { LlmClient } from "@trustgate/llm-gateway";

import type { FileDiff } from "./diff-collector.js";
import type { ReviewInput } from "./ocr-adapter.js";
import { SECURITY_PLAN_SYSTEM } from "./prompts/security-plan.js";

export const PLANNER_INPUT_MAX_BYTES = 131_072;

export type PlannerInput = ReviewInput & { diffs: FileDiff[] };

type SerializedReview = {
  mode: ReviewInput["mode"];
  files: ReviewInput["files"];
  ruleGroups: ReviewInput["ruleGroups"];
};

type SerializedPlannerInput = {
  review: SerializedReview;
  diffs: FileDiff[];
};

type ValidatedPlannerInput = {
  mode: ReviewInput["mode"];
  files: ReviewInput["files"];
  ruleGroups: ReviewInput["ruleGroups"];
  diffs: FileDiff[];
};

type ChangedLine = { line: number; text: string };

type HunkState = {
  oldLine: number;
  newLine: number;
  oldRemaining: number;
  newRemaining: number;
  markerAllowed: boolean;
};

type CompletedHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
};

type ParsedEnvelopePath = { kind: "path"; path: string } | { kind: "null" };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;
const DIFF_PREFIX = "diff --git ";
const OLD_HEADER_PREFIX = "--- ";
const NEW_HEADER_PREFIX = "+++ ";
const NO_NEWLINE_MARKER = "\\ No newline at end of file";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const invalidDiff = (path: string, reason: string): never => {
  throw new Error(`Invalid diff for ${path}: ${reason}`);
};

const decodeGitQuotedToken = (token: string): string | null => {
  if (token.length < 2 || token[0] !== '"' || token.at(-1) !== '"') {
    return null;
  }

  const bytes: number[] = [];
  for (let index = 1; index < token.length - 1; index += 1) {
    const character = token[index]!;
    if (character !== "\\") {
      const nextEscape = token.indexOf("\\", index);
      const end = nextEscape === -1 ? token.length - 1 : nextEscape;
      bytes.push(...Buffer.from(token.slice(index, end), "utf8"));
      index = end - 1;
      continue;
    }

    index += 1;
    if (index >= token.length - 1) return null;
    const escape = token[index]!;
    const simpleEscapes: Record<string, number> = {
      '"': 0x22,
      "\\": 0x5c,
      a: 0x07,
      b: 0x08,
      f: 0x0c,
      t: 0x09,
      n: 0x0a,
      r: 0x0d,
      v: 0x0b,
    };
    const simple = simpleEscapes[escape];
    if (simple !== undefined) {
      bytes.push(simple);
      continue;
    }
    if (!/[0-7]/.test(escape)) return null;

    let octal = escape;
    while (
      octal.length < 3 &&
      index + 1 < token.length - 1 &&
      /[0-7]/.test(token[index + 1]!)
    ) {
      index += 1;
      octal += token[index]!;
    }
    const byte = Number.parseInt(octal, 8);
    if (byte > 0xff) return null;
    bytes.push(byte);
  }

  try {
    return UTF8_DECODER.decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
};

const readGitToken = (
  source: string,
  offset: number,
): { value: string; next: number } | null => {
  if (offset >= source.length) return null;
  if (source[offset] !== '"') {
    const end = source.indexOf(" ", offset);
    const next = end === -1 ? source.length : end;
    if (next === offset) return null;
    return { value: source.slice(offset, next), next };
  }

  let escaped = false;
  for (let index = offset + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      const token = source.slice(offset, index + 1);
      const decoded = decodeGitQuotedToken(token);
      return decoded === null ? null : { value: decoded, next: index + 1 };
    }
  }
  return null;
};

const parseDiffEnvelope = (
  line: string,
  path: string,
): [string, string] | null => {
  if (!line.startsWith(DIFF_PREFIX)) return null;
  const source = line.slice(DIFF_PREFIX.length);
  const expectedOld = `a/${path}`;
  const expectedNew = `b/${path}`;
  if (!source.startsWith('"')) {
    return source === `${expectedOld} ${expectedNew}`
      ? [expectedOld, expectedNew]
      : null;
  }

  const oldToken = readGitToken(source, 0);
  if (oldToken === null || source[oldToken.next] !== " ") return null;
  const newToken = readGitToken(source, oldToken.next + 1);
  if (newToken === null || newToken.next !== source.length) return null;
  return [oldToken.value, newToken.value];
};

const stripFileHeaderMetadata = (token: string): string | null => {
  const delimiter = token.indexOf("\t");
  const pathToken = delimiter === -1 ? token : token.slice(0, delimiter);
  if (pathToken.length === 0) return null;
  if (pathToken.startsWith('"')) {
    return delimiter === -1 || token[delimiter - 1] === '"' ? pathToken : null;
  }
  if (delimiter === -1 && pathToken.includes(" ")) return null;
  return pathToken;
};

const parseFileHeader = (
  token: string,
  prefix: "a/" | "b/",
): ParsedEnvelopePath | null => {
  const pathToken = stripFileHeaderMetadata(token);
  if (pathToken === null) return null;
  if (pathToken === "/dev/null") return { kind: "null" };
  const decoded = pathToken.startsWith('"')
    ? decodeGitQuotedToken(pathToken)
    : pathToken;
  if (decoded === null || !decoded.startsWith(prefix)) return null;
  return { kind: "path", path: decoded.slice(prefix.length) };
};

type DiffKind = "modify" | "add" | "delete";
type DeclaredDiffKind = DiffKind | "unspecified";

const metadataKind = (line: string): DiffKind | null | undefined => {
  if (/^new file mode [0-7]{6}$/.test(line)) return "add";
  if (/^deleted file mode [0-7]{6}$/.test(line)) return "delete";
  if (
    /^(?:index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?|old mode [0-7]{6}|new mode [0-7]{6})$/.test(
      line,
    )
  ) {
    return null;
  }
  return undefined;
};

const binaryMarkerMatches = (line: string, path: string): boolean =>
  line === `Binary files a/${path} and b/${path} differ`;

const validateHunkRange = (
  path: string,
  current: CompletedHunk,
  previous: CompletedHunk | undefined,
): void => {
  const { oldStart, oldCount, newStart, newCount } = current;
  if ((oldCount > 0 && oldStart === 0) || (newCount > 0 && newStart === 0)) {
    return invalidDiff(path, "positive-count hunk ranges must start above zero");
  }
  if (
    previous === undefined &&
    ((oldCount === 0 && newCount > 0 && oldStart + 1 !== newStart) ||
      (newCount === 0 && oldCount > 0 && newStart + 1 !== oldStart))
  ) {
    return invalidDiff(path, "zero-count hunk range is not Git-canonical");
  }
  if (
    previous !== undefined &&
    (oldStart < previous.oldStart + previous.oldCount ||
      newStart < previous.newStart + previous.newCount)
  ) {
    return invalidDiff(path, "hunk ranges overlap or go backwards");
  }
};

const collectChangedLines = ({
  path,
  diff,
  truncated,
}: FileDiff): ChangedLine[] => {
  if (diff === "" && truncated) return [];

  const lines = diff.split("\n");
  if (diff.endsWith("\n")) {
    lines.pop();
  } else if (truncated) {
    lines.pop();
  }
  if (lines.length === 0 || lines[0] === "") {
    return invalidDiff(path, "missing diff --git envelope");
  }

  const envelope = parseDiffEnvelope(lines[0]!, path);
  if (envelope === null) {
    return invalidDiff(path, "malformed diff --git envelope");
  }
  if (envelope[0] !== `a/${path}` || envelope[1] !== `b/${path}`) {
    return invalidDiff(path, "envelope path mismatch");
  }

  const changedLines: ChangedLine[] = [];
  let index = 1;
  let oldHeader: ParsedEnvelopePath | undefined;
  let newHeader: ParsedEnvelopePath | undefined;
  let declaredKind: DeclaredDiffKind = "unspecified";
  let hunk: HunkState | undefined;
  let previousHunk: CompletedHunk | undefined;
  let sawHunk = false;
  let nonTextual = false;

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith(DIFF_PREFIX)) {
      return invalidDiff(path, "multiple file sections are not allowed");
    }

    if (hunk !== undefined) {
      const complete = hunk.oldRemaining === 0 && hunk.newRemaining === 0;
      if (line === NO_NEWLINE_MARKER) {
        if (!hunk.markerAllowed) {
          return invalidDiff(path, "misplaced no-newline marker");
        }
        hunk.markerAllowed = false;
        index += 1;
        continue;
      }
      if (complete) {
        hunk = undefined;
        if (!line.startsWith("@@ ")) {
          return invalidDiff(path, "line outside declared hunk counts");
        }
        continue;
      }
      if (line.startsWith("@@ ")) {
        return invalidDiff(path, "next hunk starts before current hunk is complete");
      }

      const prefix = line[0];
      if (prefix === "+") {
        if (hunk.newRemaining === 0) {
          return invalidDiff(path, "added line exceeds declared hunk count");
        }
        changedLines.push({ line: hunk.newLine, text: line.slice(1) });
        hunk.newLine += 1;
        hunk.newRemaining -= 1;
      } else if (prefix === "-") {
        if (hunk.oldRemaining === 0) {
          return invalidDiff(path, "deleted line exceeds declared hunk count");
        }
        changedLines.push({ line: hunk.oldLine, text: line.slice(1) });
        hunk.oldLine += 1;
        hunk.oldRemaining -= 1;
      } else if (prefix === " ") {
        if (hunk.oldRemaining === 0 || hunk.newRemaining === 0) {
          return invalidDiff(path, "context line exceeds declared hunk count");
        }
        hunk.oldLine += 1;
        hunk.newLine += 1;
        hunk.oldRemaining -= 1;
        hunk.newRemaining -= 1;
      } else {
        return invalidDiff(path, "malformed hunk body prefix");
      }
      hunk.markerAllowed = true;
      index += 1;
      continue;
    }

    if (oldHeader === undefined) {
      if (line.startsWith(OLD_HEADER_PREFIX)) {
        const parsed = parseFileHeader(line.slice(OLD_HEADER_PREFIX.length), "a/");
        if (parsed === null) return invalidDiff(path, "malformed old file header");
        oldHeader = parsed;
        index += 1;
        continue;
      }
      if (binaryMarkerMatches(line, path)) {
        if (nonTextual) {
          return invalidDiff(path, "duplicate non-textual diff marker");
        }
        nonTextual = true;
        index += 1;
        continue;
      }
      if (
        line.startsWith(NEW_HEADER_PREFIX) ||
        line.startsWith("@@ ") ||
        line.startsWith("Binary files ") ||
        line === "GIT binary patch"
      ) {
        return invalidDiff(path, "unexpected content before file headers");
      }
      const kind = metadataKind(line);
      if (kind === undefined) {
        return invalidDiff(path, "unexpected content before file headers");
      }
      if (kind !== null) {
        if (declaredKind !== "unspecified" && declaredKind !== kind) {
          return invalidDiff(path, "conflicting file mode metadata");
        }
        declaredKind = kind;
      }
      index += 1;
      continue;
    }

    if (newHeader === undefined) {
      if (!line.startsWith(NEW_HEADER_PREFIX)) {
        return invalidDiff(path, "new file header must follow old file header");
      }
      const parsed = parseFileHeader(line.slice(NEW_HEADER_PREFIX.length), "b/");
      if (parsed === null) return invalidDiff(path, "malformed new file header");
      newHeader = parsed;

      const validModification =
        oldHeader.kind === "path" &&
        oldHeader.path === path &&
        newHeader.kind === "path" &&
        newHeader.path === path;
      const validAddition =
        oldHeader.kind === "null" &&
        newHeader.kind === "path" &&
        newHeader.path === path;
      const validDeletion =
        oldHeader.kind === "path" &&
        oldHeader.path === path &&
        newHeader.kind === "null";
      const headerKind: DiffKind | null = validModification
        ? "modify"
        : validAddition
          ? "add"
          : validDeletion
            ? "delete"
            : null;
      if (
        headerKind === null ||
        (declaredKind !== "unspecified" && declaredKind !== headerKind)
      ) {
        return invalidDiff(path, "file header path mismatch or invalid /dev/null side");
      }
      declaredKind = headerKind;
      index += 1;
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header === null) {
      return invalidDiff(path, "expected hunk header");
    }
    const oldLine = Number(header[1]);
    const newLine = Number(header[3]);
    const oldRemaining = Number(header[2] ?? "1");
    const newRemaining = Number(header[4] ?? "1");
    if (
      !Number.isSafeInteger(oldLine) ||
      !Number.isSafeInteger(newLine) ||
      !Number.isSafeInteger(oldRemaining) ||
      !Number.isSafeInteger(newRemaining)
    ) {
      return invalidDiff(path, "hunk coordinates must be safe integers");
    }
    const currentHunk = {
      oldStart: oldLine,
      oldCount: oldRemaining,
      newStart: newLine,
      newCount: newRemaining,
    };
    validateHunkRange(path, currentHunk, previousHunk);
    previousHunk = currentHunk;
    if (declaredKind === "add" && oldRemaining !== 0) {
      return invalidDiff(path, "added-file hunk must not consume old lines");
    }
    if (declaredKind === "delete" && newRemaining !== 0) {
      return invalidDiff(path, "deleted-file hunk must not consume new lines");
    }
    hunk = {
      oldLine,
      newLine,
      oldRemaining,
      newRemaining,
      markerAllowed: false,
    };
    sawHunk = true;
    index += 1;
  }

  if (oldHeader === undefined || newHeader === undefined) {
    if (sawHunk) return invalidDiff(path, "missing file headers");
    return [];
  }
  if (nonTextual) {
    return invalidDiff(path, "binary marker cannot accompany file headers");
  }
  if (hunk !== undefined && (hunk.oldRemaining !== 0 || hunk.newRemaining !== 0)) {
    if (!truncated) return invalidDiff(path, "incomplete hunk at end of input");
  }
  if (!sawHunk) return [];
  return changedLines;
};

const validateEvidence = (plan: AnalysisPlan, diffs: FileDiff[]): void => {
  const diffsByPath = new Map(diffs.map((fileDiff) => [fileDiff.path, fileDiff]));
  const changedLinesByPath = new Map<string, ChangedLine[]>();

  for (const hypothesis of plan.hypotheses) {
    for (const evidence of hypothesis.evidence) {
      const fileDiff = diffsByPath.get(evidence.file);
      if (fileDiff === undefined) {
        throw new Error(`Ungrounded evidence: unknown file ${evidence.file}`);
      }
      let changedLines = changedLinesByPath.get(evidence.file);
      if (changedLines === undefined) {
        changedLines = collectChangedLines(fileDiff);
        changedLinesByPath.set(evidence.file, changedLines);
      }

      const excerpt = evidence.excerpt.trim();
      if (excerpt.length === 0) {
        throw new Error("Ungrounded evidence: excerpt must be non-empty");
      }

      const candidates = changedLines.filter(({ line }) => line === evidence.line);
      if (candidates.length === 0) {
        throw new Error(
          `Ungrounded evidence: ${evidence.file}:${evidence.line} is not a changed line`,
        );
      }
      if (!candidates.some(({ text }) => text.includes(excerpt))) {
        throw new Error(
          `Ungrounded evidence: excerpt is not present at ${evidence.file}:${evidence.line}`,
        );
      }
    }
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireNonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
};

const requireCount = (value: unknown, field: string): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new TypeError(`${field} must be a nonnegative safe integer`);
  }
  return value;
};

const readStable = <T>(
  object: Record<string, unknown>,
  key: string,
  field: string,
  validate: (value: unknown, field: string) => T,
): T => {
  const first = validate(object[key], field);
  const second = validate(object[key], field);
  if (!Object.is(first, second)) {
    throw new TypeError(`${field} changed during validation`);
  }
  return first;
};

const invalidInput = (message: string): never => {
  throw new TypeError(message);
};

const serializeInput = (
  input: PlannerInput,
): { serialized: string; validated: ValidatedPlannerInput } => {
  const candidate: unknown = input;
  if (!isObject(candidate)) {
    throw new TypeError("input must be an object");
  }
  if (
    candidate.mode !== "workspace" &&
    candidate.mode !== "range" &&
    candidate.mode !== "commit"
  ) {
    throw new TypeError("mode must be workspace, range, or commit");
  }
  if (!Array.isArray(candidate.files)) {
    throw new TypeError("files must be an array");
  }
  if (!Array.isArray(candidate.ruleGroups)) {
    throw new TypeError("ruleGroups must be an array");
  }
  if (!Array.isArray(candidate.diffs)) {
    throw new TypeError("diffs must be an array");
  }
  const validatedInput = candidate as unknown as PlannerInput;
  if (validatedInput.files.length === 0 || validatedInput.diffs.length === 0) {
    throw new Error("review files and diffs must be non-empty");
  }

  const reviewPaths = new Set<string>();
  const serializedFiles = validatedInput.files.map((file, index) => {
    if (!isObject(file)) {
      throw new TypeError(`files[${index}] must be an object`);
    }
    const path = readStable(
      file,
      "path",
      `review files[${index}].path`,
      requireNonEmptyString,
    );
    const serializedFile = {
      path,
      status: readStable(
        file,
        "status",
        `review files[${index}].status`,
        requireNonEmptyString,
      ),
      additions: readStable(
        file,
        "additions",
        `review files[${index}].additions`,
        requireCount,
      ),
      deletions: readStable(
        file,
        "deletions",
        `review files[${index}].deletions`,
        requireCount,
      ),
    };
    if (reviewPaths.has(path)) {
      throw new Error(`duplicate review file path: ${path}`);
    }
    reviewPaths.add(path);
    return serializedFile;
  });

  if (validatedInput.ruleGroups.length === 0) {
    throw new Error("rule groups must be non-empty");
  }
  const groupedPaths = new Set<string>();
  for (const [groupIndex, group] of validatedInput.ruleGroups.entries()) {
    if (!isObject(group)) {
      throw new TypeError(`ruleGroups[${groupIndex}] must be an object`);
    }
    if (!Array.isArray(group.files)) {
      throw new TypeError(`ruleGroups[${groupIndex}].files must be an array`);
    }
    if (typeof group.rules !== "string") {
      throw new TypeError(`ruleGroups[${groupIndex}].rules must be a string`);
    }
    if (group.files.length === 0) {
      throw new Error(`ruleGroups[${groupIndex}].files must be non-empty`);
    }
    for (const [fileIndex, path] of group.files.entries()) {
      if (typeof path !== "string") {
        throw new TypeError(
          `ruleGroups[${groupIndex}].files[${fileIndex}] must be a string`,
        );
      }
      if (!reviewPaths.has(path)) {
        throw new Error(`unknown rule-group path: ${path}`);
      }
      if (groupedPaths.has(path)) {
        throw new Error(`duplicate rule-group path: ${path}`);
      }
      groupedPaths.add(path);
    }
  }
  for (const path of reviewPaths) {
    if (!groupedPaths.has(path)) {
      throw new Error(`missing rule-group path: ${path}`);
    }
  }

  const diffsByPath = new Map<string, FileDiff>();
  for (const [index, fileDiff] of validatedInput.diffs.entries()) {
    if (!isObject(fileDiff)) {
      throw new TypeError(`diffs[${index}] must be an object`);
    }
    const path = requireNonEmptyString(fileDiff.path, `diffs[${index}].path`);
    if (diffsByPath.has(path)) {
      throw new Error(`duplicate diff path: ${path}`);
    }
    if (!reviewPaths.has(path)) {
      throw new Error(`unknown diff path: ${path}`);
    }
    if (typeof fileDiff.diff !== "string") {
      throw new TypeError(`diffs[${index}].diff must be a string`);
    }
    if (typeof fileDiff.truncated !== "boolean") {
      throw new TypeError(`diffs[${index}].truncated must be a boolean`);
    }
    diffsByPath.set(path, fileDiff as FileDiff);
  }

  const orderedDiffs = validatedInput.files.map(({ path }) => {
    const fileDiff = diffsByPath.get(path);
    if (fileDiff === undefined) {
      throw new Error(`missing diff path: ${path}`);
    }
    return {
      path: requireNonEmptyString(fileDiff.path, `diff for ${path}.path`),
      diff:
        typeof fileDiff.diff === "string"
          ? fileDiff.diff
          : invalidInput(`diff for ${path}.diff must be a string`),
      truncated:
        typeof fileDiff.truncated === "boolean"
          ? fileDiff.truncated
          : invalidInput(`diff for ${path}.truncated must be a boolean`),
    };
  });

  const serializedRuleGroups = validatedInput.ruleGroups.map(
    (group, groupIndex) => {
      if (!Array.isArray(group.files) || typeof group.rules !== "string") {
        throw new TypeError(`ruleGroups[${groupIndex}] changed during validation`);
      }
      const files = group.files.map((filePath, fileIndex) => {
        if (typeof filePath !== "string") {
          throw new TypeError(
            `ruleGroups[${groupIndex}].files[${fileIndex}] must be a string`,
          );
        }
        return filePath;
      });
      return { files, rules: group.rules };
    },
  );
  const validated: ValidatedPlannerInput = {
    mode: validatedInput.mode,
    files: serializedFiles,
    ruleGroups: serializedRuleGroups,
    diffs: orderedDiffs,
  };
  const serializedInput: SerializedPlannerInput = {
    review: {
      mode: validated.mode,
      files: validated.files,
      ruleGroups: validated.ruleGroups,
    },
    diffs: validated.diffs,
  };
  const serialized = JSON.stringify(serializedInput);
  if (Buffer.byteLength(serialized, "utf8") > PLANNER_INPUT_MAX_BYTES) {
    throw new RangeError(
      `Planner input exceeds ${PLANNER_INPUT_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return { serialized, validated };
};

export const createSecurityPlanner = (client: LlmClient) => ({
  async plan(input: PlannerInput): Promise<AnalysisPlan> {
    const { serialized, validated } = serializeInput(input);
    const response = await client.generate({
      system: SECURITY_PLAN_SYSTEM,
      messages: [{ role: "user", content: serialized }],
      temperature: 0,
      maxTokens: 3000,
    });
    const plan = parseContractJson(analysisPlanSchema, response.text);
    validateEvidence(plan, validated.diffs);
    return plan;
  },
});
