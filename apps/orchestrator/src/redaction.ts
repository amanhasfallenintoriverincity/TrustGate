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
 * `REDACTION_FAILURE_LINE`; `createRedactingSink` replaces a record it cannot redact — or cannot
 * serialize after redacting — with `REDACTION_FAILURE_RECORD`. The original is never emitted and
 * the line or record is never dropped silently. `redactRecord` returns the same reference when
 * nothing matched, so benign records stay byte-identical (and are not copied).
 *
 * Boundary: the rules match literal text. A credential that is itself encoded (base64, percent,
 * hex) is not decoded here; a credential written verbatim inside an encoded surrounding (for
 * example `Authorization%3A%20Bearer%20ghp_…`) is still removed by value matching, and the
 * separators and gaps the rules recognise include the percent-encoded forms (`%3A`, `%3D`,
 * `%20`). A credential written after an already redacted scheme body (`Bearer [REDACTED] <body>`)
 * is removed by the scheme-chain rule, which keeps the marker and replaces only the body.
 *
 * Accepted boundaries (deliberate trades, not defects):
 * - Encoding is not decoded. The boundary above stays as it is: an encoded credential keeps its
 *   encoded form, and only a credential written verbatim inside an encoded surrounding is removed
 *   by value matching. Decoding at this layer would add attack surface for no gain.
 * - Prose that merely reads like a scheme can still be over-redacted: after a scheme word, a
 *   long word (seven characters or more) reads as a credential-shaped body and is masked.
 *   Near-misses such as `the bearer of good news`, `basic terms and conditions` and
 *   `token budget` stay readable. Machine-generated JSON logs lose nothing either way, and a
 *   false positive is the safe direction to err in, so the trade stands.
 * - The credential-path scan widens at most 512 characters on each side of a marker, so an
 *   unusually long unbroken run around a path loses only that window, never the whole line.
 * - Credential-name prefixes (≤64 characters), api-key prefixes (≤8 `word_` segments), scheme
 *   prefixes (≤64) and URL userinfo (≤255) are matched with a bounded width. Those caps keep the
 *   match linear on an adversarial single line — the unbounded form was measured at 5.5 seconds on
 *   a 64KB line — and an input past a cap loses only that one match, never the whole line.
 */

/** Written in place of every credential-shaped match. */
export const REDACTED = "[REDACTED]";

/** Sentinel line used when a record cannot be serialized or redacted. Fixed text, no input. */
export const REDACTION_FAILURE_LINE = '{"event":"log.redaction_failed"}\n';

/** Sentinel record handed to a sink when a record cannot be redacted or serialized. Fixed text. */
export const REDACTION_FAILURE_RECORD: { readonly event: string } = { event: "log.redaction_failed" };

/** Whitespace plus the zero-width characters that survive copy/paste through header text, plus
 *  the percent-encoded space that shows up inside encoded surroundings. */
const GAP = "(?:[\\s\\u200b-\\u200d\\ufeff]|%20)";

/** One scheme-word list shared by the matchers and every guard, so the two can never drift apart. */
const SCHEME_WORD = "bearer|basic|token|digest";

/** `"value"` | `'value'` | bare token: the three shapes a credential takes after a separator. */
const VALUE = `(?:"((?:\\\\"|[^"\\r\\n]){1,})"|'((?:\\\\'|[^'\\r\\n]){1,})'|((?:\\\\["']|[^\\s"',;}\\]\\[]){1,}))`;
/** The value grammar for scheme words: a bare value needs seven characters, so prose such as
 * `token budget` survives while `Bearer hunter2hunter` is still masked. */
const SCHEME_VALUE = `(?:"((?:\\\\"|[^"\\r\\n]){1,})"|'((?:\\\\'|[^'\\r\\n]){1,})'|((?:\\\\["']|[^\\s"',;}\\]\\[]){7,}))`;

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
  `\\b(${SCHEME_WORD})(${GAP}+)(?!(?:authentication|authorization|scheme|header)\\b)(?!(?:${SCHEME_WORD})${GAP})${SCHEME_VALUE}`,
  "gi",
);

/**
 * The scheme chain: a credential written after an already redacted scheme body, for example
 * `Authorization: Bearer [REDACTED] <credential>`. The other rules never look past a marker, so
 * that body would otherwise survive; this rule keeps the scheme words and the marker and replaces
 * only the body. The bare branch demands thirteen characters and refuses assignment separators, so the next scheme word in
 * `Bearer [REDACTED] Bearer <credential>` is never mistaken for the body.
 */
const SCHEME_CHAIN_PATTERN = new RegExp(
  `\\b(${SCHEME_WORD})(${GAP}+)((?:\\[REDACTED\\]${GAP}+)+)` +
    `(?:"((?:\\\\"|[^"\\r\\n]){1,})"|'((?:\\\\'|[^'\\r\\n]){1,})'|((?:\\\\["']|[^\\s"',;}\\]\\[=:]){13,}))`,
  "gi",
);

/** `Authorization: <credential>` covering a missing scheme, an unknown one and quoted values. */
const AUTHORIZATION_PATTERN = new RegExp(
  `\\b(authorization)(["']?${GAP}*(?:[:=]|%3A|%3D)${GAP}*)(?:(${SCHEME_WORD})${GAP}+)?` +
    `(?!\\[REDACTED\\])(?!${GAP}*(?:${SCHEME_WORD})\\b)${VALUE}`,
  "gi",
);

/** `x-api-key: <credential>`, `apiKey=<credential>`, `API_KEY=<credential>`. */
const API_KEY_PATTERN = new RegExp(
  `\\b((?:[A-Za-z0-9]+[_-]){0,8}api[-_]?key)(["']?${GAP}*(?:[:=]|%3A|%3D)${GAP}*)(?!\\[REDACTED\\])${VALUE}`,
  "gi",
);

/** `GITHUB_TOKEN=…`, `DB_PASSWORD=…`, `PASS`, `PWD`, `CREDS`: suffix matching, so any trailing
 *  fragment joins the name (`apiKey` and `userPassword` are covered the same way). */
const SECRET_NAME =
  "[A-Za-z0-9_-]{0,64}(?:API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|SECRET[_-]?ACCESS[_-]?KEY|TOKEN|SECRET|" +
  "PASSWORD|PASSWD|PASSPHRASE|PASS|PWD|CREDS|CREDENTIALS?|BEARER|COOKIE|PRIVATE[_-]?KEY|" +
  "SESSION[_-]?KEY|SIGNING[_-]?KEY)";
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${SECRET_NAME})(["']?${GAP}*(?:[:=]|%3A|%3D)${GAP}*)(?!\\[REDACTED\\])${VALUE}`,
  "gi",
);

/** Credential bodies that stand alone: GitHub, Anthropic/OpenAI, GitLab, Slack, AWS, GCP, JWTs.
 *  The guard admits a token after plain text, a non-word character or a percent-encoded byte —
 *  `%20ghp_…`, `path%2Fghp_…` — while still refusing a token glued to a word (`xghp_…`). */
const CREDENTIAL_TOKEN_PATTERN =
  /(?<=^|[^\w]|%[0-9A-Fa-f]{2})(?:github_pat_[A-Za-z0-9_]{4,}|gh[pousr]_[A-Za-z0-9_]{4,}|(?:sk-ant|sk-proj)-[A-Za-z0-9_-]{4,}|sk-[A-Za-z0-9_-]{12,}|glpat-[A-Za-z0-9_-]{4,}|xox[baprs]-[A-Za-z0-9-]{8,}|npm_[A-Za-z0-9]{12,}|hf_[A-Za-z0-9]{12,}|xai-[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*)/g;

/** PEM private key material, including a block whose END marker never made it into the line. */
const PRIVATE_KEY_PATTERN = /-----BEGIN[^-]{0,80}PRIVATE KEY-----[\s\S]*?(?:-----END[^-]{0,80}PRIVATE KEY-----|$)/g;

/** Credential-file markers: the codex OAuth file, SSH material, AWS files and netrc. */
const PATH_MARKER_PATTERN = /\.codex[\\/]|\.ssh[\\/]|\.aws[\\/]|\.netrc(?![\w])/gi;

/** Stops the credential-path widening: the boundary set the previous single-pattern scan used. */
const PATH_STOP = /[\s"',;)\]<>|=]/;

/** Widening cap, in characters, on each side of a credential-file marker. */
const PATH_WINDOW = 512;

/** `scheme://user:password@host`, so the password never survives inside a URL. */
const USERINFO_PATTERN = /([A-Za-z][A-Za-z0-9+.-]{0,63}:\/\/)([^\s/@:]{0,255}):([^\s/@]{1,255})@/g;

const replaceScheme = (line: string): string => line.replace(SCHEME_PATTERN, credentialReplacer([2, 3, 4]));
const replaceSchemeChain = (line: string): string =>
  line.replace(SCHEME_CHAIN_PATTERN, credentialReplacer([3, 4, 5]));
const replaceAuthorization = (line: string): string =>
  line.replace(AUTHORIZATION_PATTERN, credentialReplacer([3, 4, 5]));
const replaceApiKey = (line: string): string => line.replace(API_KEY_PATTERN, credentialReplacer([2, 3, 4]));
const replaceSecret = (line: string): string => line.replace(SECRET_ASSIGNMENT_PATTERN, credentialReplacer([2, 3, 4]));
const replaceUserinfo = (line: string): string =>
  line.replace(USERINFO_PATTERN, (_match: string, scheme: string, user: string): string => `${scheme}${user}:${REDACTED}@`);
const replaceTokens = (line: string): string => line.replace(CREDENTIAL_TOKEN_PATTERN, REDACTED);
const replacePrivateKeys = (line: string): string => line.replace(PRIVATE_KEY_PATTERN, REDACTED);

/**
 * Linear credential-path scan: every marker widens at most `PATH_WINDOW` characters per side in a
 * single bounded pass — no backtracking and no unbounded character class, so a pathological line
 * cannot turn this into quadratic work. Overlapping widenings are merged before the spans are
 * collapsed into `[REDACTED]`, which also keeps the rule idempotent.
 */
const replaceCodexPaths = (line: string): string => {
  const spans: Array<[number, number]> = [];
  PATH_MARKER_PATTERN.lastIndex = 0;
  for (let match = PATH_MARKER_PATTERN.exec(line); match !== null; match = PATH_MARKER_PATTERN.exec(line)) {
    let start = match.index;
    let end = match.index + match[0].length;
    let width = 0;
    while (start > 0 && width < PATH_WINDOW && !PATH_STOP.test(line[start - 1] as string)) {
      start -= 1;
      width += 1;
    }
    width = 0;
    while (end < line.length && width < PATH_WINDOW && !PATH_STOP.test(line[end] as string)) {
      end += 1;
      width += 1;
    }
    spans.push([start, end]);
  }
  if (spans.length === 0) return line;

  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span[0] <= last[1]) {
      if (span[0] < last[0]) last[0] = span[0];
      if (span[1] > last[1]) last[1] = span[1];
      continue;
    }
    merged.push(span);
  }

  let output = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    output += line.slice(cursor, start) + REDACTED;
    cursor = end;
  }
  return output + line.slice(cursor);
};

/**
 * Rules are applied in order; every rule is idempotent and never re-matches its own placeholder.
 */
const RULES: readonly ((line: string) => string)[] = [
  replacePrivateKeys,
  replaceScheme,
  replaceSchemeChain,
  replaceAuthorization,
  replaceApiKey,
  replaceSecret,
  replaceUserinfo,
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

/** Record keys whose values are credentials by convention, matched as suffixes: `apiKey`,
 *  `DB_PASSWORD`, `accessToken`, `x-api-key` … — so `tokenBudget` and `maxTokens` stay untouched. */
const SENSITIVE_KEY =
  /^[A-Za-z0-9_-]*(?:api[_-]?key|api[_-]?secret|access[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|auth[_-]?token|id[_-]?token|session[_-]?key|signing[_-]?key|private[_-]?key|secret[_-]?access[_-]?key|client[_-]?secret|password|passwd|passphrase|pass|pwd|creds|credentials?|secret|token|bearer|cookie)$/i;

/**
 * Walks a value, redacting every string it contains; returns the same reference if untouched.
 * Handles plain objects, class instances (the prototype is preserved), arrays, `Map` and `Set`;
 * a reference cycle contributes `REDACTED` instead of escaping as a raw object. A string value
 * under a sensitive key name is replaced wholesale, without relying on it matching a rule.
 */
const redactValue = (value: unknown, seen: WeakSet<object>): unknown => {
  if (typeof value === "string") return redact(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return REDACTED;
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

  if (value instanceof Map) {
    let changed = false;
    const next = new Map<unknown, unknown>();
    value.forEach((entry: unknown, key: unknown) => {
      const redactedKey = redactValue(key, seen);
      const redactedEntry = redactValue(entry, seen);
      if (redactedKey !== key || redactedEntry !== entry) changed = true;
      next.set(redactedKey, redactedEntry);
    });
    return changed ? next : value;
  }

  if (value instanceof Set) {
    let changed = false;
    const next = new Set<unknown>();
    value.forEach((entry: unknown) => {
      const redacted = redactValue(entry, seen);
      if (redacted !== entry) changed = true;
      next.add(redacted);
    });
    return changed ? next : value;
  }

  let changed = false;
  const next = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && typeof entry === "string") {
      next[key] = REDACTED;
      changed = true;
      continue;
    }
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
 *
 * Fail-closed: a record this layer cannot redact, or cannot serialize after redacting, is
 * replaced with the fixed sentinel. The original value is never handed to the sink, and the sink
 * is never skipped, so a failure stays visible without leaking anything.
 */
export const createRedactingSink = <LogRecord extends object>(
  sink: (record: LogRecord) => void,
): ((record: LogRecord) => void) =>
  (record) => {
    let safe: LogRecord;
    try {
      const redacted = redactRecord(record);
      if (JSON.stringify(redacted) === undefined) throw new Error("record is not serializable");
      safe = redacted;
    } catch {
      safe = REDACTION_FAILURE_RECORD as unknown as LogRecord;
    }
    sink(safe);
  };
