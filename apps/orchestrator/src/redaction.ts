/**
 * Central redaction for everything the orchestrator writes to its runtime output.
 *
 * The log record unions in `main.ts`/`server.ts` are closed and carry metadata only, so this
 * module is a defence layer for the paths that stay open by construction: free-form fields,
 * embedder-supplied records, exception messages and any field added later. It is applied once per
 * sink — `serializeLogLine` inside `writeLog` (the orchestrator's only stdout sink) and
 * `createRedactingSink` at the server's log callback — so no record reaches a sink unredacted.
 *
 * Fail-closed: `redactLine`/`serializeLogLine` replace a line they cannot redact with
 * `REDACTION_FAILURE_LINE`. The original text is never emitted, and the line is never dropped
 * silently. `redactRecord` returns the same reference when nothing matched, so benign records
 * stay byte-identical (and are not copied).
 *
 * Boundary: the rules match literal text. A credential that is itself encoded (base64, percent,
 * hex) is not decoded here; a credential written verbatim inside an encoded surrounding (for
 * example `Authorization%3A%20Bearer%20ghp_…`) is still removed by value matching.
 *
 * Accepted boundaries (deliberate trades, not defects):
 * - Encoding is not decoded. The boundary above stays as it is: an encoded credential keeps its
 *   encoded form, and only a credential written verbatim inside an encoded surrounding is removed
 *   by value matching. Decoding at this layer would add attack surface for no gain.
 * - Prose that merely reads like a scheme is over-redacted. `the bearer of good news` becomes
 *   `the bearer [REDACTED] good news`, and `basic terms and conditions` behaves the same way.
 *   Machine-generated JSON logs lose nothing in those sentences, and a false positive is the safe
 *   direction to err in, so the over-match is accepted rather than narrowed.
 */

/** Written in place of every credential-shaped match. */
export const REDACTED = "[REDACTED]";

/** Sentinel line used when a record cannot be serialized or redacted. Fixed text, no input. */
export const REDACTION_FAILURE_LINE = '{"event":"log.redaction_failed"}\n';

/** Whitespace plus the zero-width characters that survive copy/paste through header text. */
const GAP = "[\\s\\u200b-\\u200d\\ufeff]";

/** `"value"` | `'value'` | bare token: the three shapes a credential takes after a separator. */
const VALUE = `(?:"([^"\\r\\n]{1,})"|'([^'\\r\\n]{1,})'|([^\\s"',;}\\]\\[]{1,}))`;

/**
 * Rebuilds a match from its captured prefix and the credential branch that matched, so the
 * surrounding text — including any quoting — is preserved exactly.
 *
 * `valueIndexes` are the capture array indexes of the double-quoted, single-quoted and bare
 * value branches; every capture before them is a prefix that is re-emitted.
 */
const credentialReplacer =
  (valueIndexes: readonly [number, number, number]) =>
  (match: string, ...args: unknown[]): string => {
    const captures = args.slice(0, -2) as (string | undefined)[];
    const [doubleIndex, singleIndex, bareIndex] = valueIndexes;
    const prefix = captures
      .slice(0, doubleIndex)
      .filter((part): part is string => typeof part === "string")
      .join("");

    if (captures[doubleIndex] !== undefined) return `${prefix}"${REDACTED}"`;
    if (captures[singleIndex] !== undefined) return `${prefix}'${REDACTED}'`;
    if (captures[bareIndex] !== undefined) return `${prefix}${REDACTED}`;
    return match;
  };

/** `Bearer <credential>` / `Basic <credential>`, with or without an `Authorization` prefix. */
const SCHEME_PATTERN = new RegExp(
  `\\b(bearer|basic)(${GAP}+)(?!(?:authentication|authorization|scheme|header)\\b)(?!(?:bearer|basic)${GAP})${VALUE}`,
  "gi",
);

/** `Authorization: <credential>`, covering a missing scheme, an unknown one and quoted values. */
const AUTHORIZATION_PATTERN = new RegExp(
  `\\b(authorization)(["']?${GAP}*[:=]${GAP}*)(?:(bearer|basic|token|digest)${GAP}+)?` +
    `(?!\\[REDACTED\\])(?!(?:bearer|basic|token|digest)\\b)${VALUE}`,
  "gi",
);

/** `x-api-key: <credential>`, `apiKey=<credential>`, `API_KEY=<credential>`. */
const API_KEY_PATTERN = new RegExp(
  `\\b((?:[A-Za-z0-9]+[_-])*api[-_]?key)(["']?${GAP}*[:=]${GAP}*)(?!\\[REDACTED\\])${VALUE}`,
  "gi",
);

/** `GITHUB_TOKEN=…`, `DB_PASSWORD=…`, `AWS_SECRET_ACCESS_KEY=…`, `TRUSTGATE_LLM_API_KEY=…`. */
const SECRET_NAME =
  "(?:[A-Za-z0-9]+[_-])*(?:API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|SECRET[_-]?ACCESS[_-]?KEY|" +
  "TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|PRIVATE[_-]?KEY|SESSION[_-]?KEY|SIGNING[_-]?KEY)";
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${SECRET_NAME})(["']?${GAP}*[:=]${GAP}*)(?!\\[REDACTED\\])${VALUE}`,
  "gi",
);

/** Credential bodies that stand alone: GitHub, Anthropic/OpenAI, GitLab, Slack, AWS, GCP, JWTs. */
const CREDENTIAL_TOKEN_PATTERN =
  /\b(?:github_pat_[A-Za-z0-9_]{4,}|gh[pousr]_[A-Za-z0-9_]{4,}|(?:sk-ant|sk-proj)-[A-Za-z0-9_-]{4,}|sk-[A-Za-z0-9_-]{12,}|glpat-[A-Za-z0-9_-]{4,}|xox[baprs]-[A-Za-z0-9-]{8,}|npm_[A-Za-z0-9]{12,}|hf_[A-Za-z0-9]{12,}|xai-[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*)/g;

/** PEM private key material, including a block whose END marker never made it into the line. */
const PRIVATE_KEY_PATTERN = /-----BEGIN[^-]{0,80}PRIVATE KEY-----[\s\S]*?(?:-----END[^-]{0,80}PRIVATE KEY-----|$)/g;

/** The codex OAuth credential file, wherever the line happens to point at it. */
const CODEX_PATH_PATTERN = /(?<![\w])[^\s"',;)\]<>|=]*(?:\.codex[\\/])[^\s"',;)\]<>|=]*/gi;

const replaceScheme = (line: string): string => line.replace(SCHEME_PATTERN, credentialReplacer([2, 3, 4]));
const replaceAuthorization = (line: string): string =>
  line.replace(AUTHORIZATION_PATTERN, credentialReplacer([3, 4, 5]));
const replaceApiKey = (line: string): string => line.replace(API_KEY_PATTERN, credentialReplacer([2, 3, 4]));
const replaceSecret = (line: string): string => line.replace(SECRET_ASSIGNMENT_PATTERN, credentialReplacer([2, 3, 4]));
const replaceTokens = (line: string): string => line.replace(CREDENTIAL_TOKEN_PATTERN, REDACTED);
const replacePrivateKeys = (line: string): string => line.replace(PRIVATE_KEY_PATTERN, REDACTED);
const replaceCodexPaths = (line: string): string => line.replace(CODEX_PATH_PATTERN, REDACTED);

/**
 * Rules are applied in order; every rule is idempotent and never re-matches its own placeholder.
 */
const RULES: readonly ((line: string) => string)[] = [
  replacePrivateKeys,
  replaceScheme,
  replaceAuthorization,
  replaceApiKey,
  replaceSecret,
  replaceTokens,
  replaceCodexPaths,
];

/** Redacts every credential-shaped run in `input`. Throws on non-string input (see `redactLine`). */
export const redact = (input: string): string => {
  if (typeof input !== "string") throw new TypeError("redact() expects a string");
  let output = input;
  for (const rule of RULES) output = rule(output);
  return output;
};

/** Fail-closed line redaction: a line that cannot be redacted becomes `REDACTION_FAILURE_LINE`. */
export const redactLine = (line: string): string => {
  try {
    return redact(line);
  } catch {
    return REDACTION_FAILURE_LINE;
  }
};

/** Serializes a log record to its single-line JSON form, redacted and fail-closed. */
export const serializeLogLine = (record: unknown): string => {
  try {
    const json = JSON.stringify(record);
    if (typeof json !== "string") return REDACTION_FAILURE_LINE;
    return redactLine(`${json}\n`);
  } catch {
    return REDACTION_FAILURE_LINE;
  }
};

/** Walks a value, redacting every string it contains; returns the same reference if untouched. */
const redactValue = (value: unknown, seen: WeakSet<object>): unknown => {
  if (typeof value === "string") return redact(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const redacted = redactValue(entry, seen);
      if (redacted !== entry) changed = true;
      return redacted;
    });
    return changed ? next : value;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const redacted = redactValue(entry, seen);
    if (redacted !== entry) changed = true;
    next[key] = redacted;
  }
  return changed ? next : value;
};

/** Redacts every string field of a record, nested values included. Benign records are untouched. */
export const redactRecord = <LogRecord>(record: LogRecord): LogRecord =>
  redactValue(record, new WeakSet<object>()) as LogRecord;

/**
 * Wraps a log sink so it can only ever observe redacted records. Applied once, where the sink is
 * wired — callers keep passing the same records, future fields included.
 */
export const createRedactingSink = <LogRecord extends object>(
  sink: (record: LogRecord) => void,
): ((record: LogRecord) => void) =>
  (record) => {
    sink(redactRecord(record));
  };
