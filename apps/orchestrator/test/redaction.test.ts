import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REDACTED,
  REDACTION_FAILURE_LINE,
  createRedactingSink,
  redact,
  redactLine,
  redactRecord,
  serializeLogLine,
} from "../src/redaction.js";
import { buildServer, createDefaultExecutor, type RunLogRecord } from "../src/server.js";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Synthetic credentials: obviously fake dummies, never a real value. */
const fakeToken = (prefix: string, length = 24): string => `${prefix}${"A".repeat(length)}`;
const fakeSecret = (...parts: readonly string[]): string => parts.join("");

/** Asserts the credential is gone, without echoing it into the failure message. */
const assertNoSecret = (output: string, secrets: readonly string[], label = "output"): void => {
  for (const secret of secrets) {
    assert.equal(
      output.includes(secret),
      false,
      `${label} still carries a credential shaped like "${secret.slice(0, 4)}" (${secret.length} chars)`,
    );
  }
};

test("redacts the documented credential shapes in a mixed line", () => {
  const bearer = fakeSecret("bearer", "-", "A".repeat(48));
  const headerValue = fakeToken("B", 24);
  const envToken = fakeToken("ghp_", 36);
  const codexPath = "/home/alice/.codex/auth.json";

  const input = `Authorization: Bearer ${bearer} x-api-key=${headerValue} GITHUB_TOKEN=${envToken} ${codexPath}`;
  const output = redact(input);

  assertNoSecret(output, [bearer, headerValue, envToken, codexPath, "/home/alice"]);
  // Context survives, so the line is still diagnosable.
  assert.ok(output.includes("Authorization: Bearer"));
  assert.ok(output.includes("x-api-key="));
  assert.ok(output.includes("GITHUB_TOKEN="));
  assert.ok(output.includes(REDACTED));
});

test("redacts header variants: case, spacing, folding and zero-width separators", () => {
  const token = fakeToken("C", 28);
  const cases: readonly (readonly [string, string])[] = [
    [`authorization: bearer ${token}`, token],
    [`AUTHORIZATION: BEARER ${token}`, token],
    [`Authorization: BeArEr ${token}`, token],
    [`Authorization: bearer\t${token}`, token],
    [`Authorization:  bearer   ${token}`, token],
    [`authorization : bearer ${token}`, token],
    [`authorization=bearer ${token}`, token],
    [`Authorization: Bearer\u00a0${token}`, token],
    [`Authorization: Bearer\u200b${token}`, token],
    [`Authorization:\n\tBearer ${token}`, token],
    [`authorization: Bearer\n  ${token}`, token],
    [`authorization: Bearer "${token}"`, token],
    [`Bearer ${token}`, token],
    [`bearer\t${token}`, token],
    [`authorization: ${token}`, token],
    [`authorization: Basic ${fakeToken("Q", 32)}`, fakeToken("Q", 32)],
    [`Authorization: token ${token}`, token],
    [`AUTHORIZATION: Basic ${fakeToken("R", 32)}`, fakeToken("R", 32)],
  ];

  cases.forEach(([line, secret], index) => {
    assertNoSecret(redact(line), [secret], `header variant ${index}`);
  });
});

test("redacts assignment and environment forms", () => {
  const cases: readonly (readonly [string, string])[] = [
    [`GITHUB_TOKEN=${fakeToken("ghp_", 36)}`, fakeToken("ghp_", 36)],
    [`OPENAI_API_KEY=${fakeToken("sk-", 32)}`, fakeToken("sk-", 32)],
    [`ANTHROPIC_API_KEY=${fakeToken("sk-ant-", 24)}`, fakeToken("sk-ant-", 24)],
    [`TRUSTGATE_LLM_API_KEY=${fakeToken("sk-", 32)}`, fakeToken("sk-", 32)],
    [`MY_SERVICE_SECRET=${fakeToken("S", 20)}`, fakeToken("S", 20)],
    [`DB_PASSWORD=${fakeToken("P", 20)}`, fakeToken("P", 20)],
    [`AWS_SECRET_ACCESS_KEY=${fakeToken("K", 20)}`, fakeToken("K", 20)],
    [`CLIENT_CREDENTIALS=${fakeToken("D", 20)}`, fakeToken("D", 20)],
    [`SOME_PRIVATE_KEY=${fakeToken("E", 20)}`, fakeToken("E", 20)],
    [`SESSION_TOKEN=${fakeToken("F", 20)}`, fakeToken("F", 20)],
    [`GITHUB_TOKEN="${fakeToken("ghp_", 36)}"`, fakeToken("ghp_", 36)],
    [`GITHUB_TOKEN='${fakeToken("ghp_", 36)}'`, fakeToken("ghp_", 36)],
    [`{"GITHUB_TOKEN":"${fakeToken("ghp_", 36)}"}`, fakeToken("ghp_", 36)],
    [`{"apiKey":"${fakeToken("G", 24)}"}`, fakeToken("G", 24)],
    [`{"nested":{"webhook_secret":"${fakeToken("H", 24)}"}}`, fakeToken("H", 24)],
    [`x-api-key: ${fakeToken("I", 24)}`, fakeToken("I", 24)],
    [`X-API-KEY: ${fakeToken("J", 24)}`, fakeToken("J", 24)],
    [`ApiKey = ${fakeToken("L", 24)}`, fakeToken("L", 24)],
    [`api_key=${fakeToken("M", 24)}`, fakeToken("M", 24)],
    [`x_api_key = "${fakeToken("N", 24)}"`, fakeToken("N", 24)],
    [`API_KEY: ${fakeToken("O", 24)}`, fakeToken("O", 24)],
  ];

  cases.forEach(([line, secret], index) => {
    assertNoSecret(redact(line), [secret], `assignment ${index}`);
  });
});

test("redacts standalone credential prefixes and JSON web tokens", () => {
  const jwt = fakeSecret("eyJ", "A".repeat(20), ".", "B".repeat(20), ".", "C".repeat(20));
  const credentials = [
    fakeToken("ghp_", 36),
    fakeToken("gho_", 36),
    fakeToken("ghs_", 36),
    fakeToken("ghr_", 36),
    fakeToken("github_pat_", 40),
    fakeToken("sk-", 32),
    fakeToken("sk-ant-", 24),
    fakeToken("sk-proj-", 24),
    fakeToken("glpat-", 24),
    fakeToken("xoxb-", 24),
    fakeToken("AKIA", 16),
    fakeToken("AIza", 35),
    jwt,
  ];

  for (const [index, credential] of credentials.entries()) {
    assertNoSecret(redact(`detail: ${credential}`), [credential], `standalone ${index}`);
    assertNoSecret(redact(`{"detail":"token ${credential}"}`), [credential], `embedded ${index}`);
  }

  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    fakeToken("k", 32),
    fakeToken("m", 32),
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  assertNoSecret(redact(pem), [fakeToken("k", 32), fakeToken("m", 32)], "pem");
});

test("redacts codex credential paths in every documented form", () => {
  const paths = [
    "/home/alice/.codex/auth.json",
    "/Users/bob/.codex/auth.json",
    "/root/.codex/auth.json",
    "~/.codex/auth.json",
    "$HOME/.codex/auth.json",
    "${HOME}/.codex/auth.json",
    "%USERPROFILE%\\.codex\\auth.json",
    "C:\\Users\\carol\\.codex\\auth.json",
    ".codex/auth.json",
  ];

  for (const [index, path] of paths.entries()) {
    const output = redact(`reading ${path} failed`);
    assertNoSecret(output, [".codex", "auth.json"], `codex path ${index}`);
    assert.ok(output.includes("reading"), `path ${index} mangled its context`);
  }

  const json = `{"event":"request","method":"GET","route":"${paths[0]}","statusCode":200}`;
  const output = redact(json);
  assertNoSecret(output, ["/home/alice", ".codex"], "codex path in json");
  assert.deepEqual(JSON.parse(output), {
    event: "request",
    method: "GET",
    route: REDACTED,
    statusCode: 200,
  });
});

test("redacts repeated, multiple and nested credentials in one payload", () => {
  const bearer = fakeToken("ghp_", 36);
  const headerValue = fakeToken("X", 24);
  const envToken = fakeToken("sk-ant-", 24);
  const input = [
    `Authorization: Bearer ${bearer}`,
    `Authorization: Bearer ${bearer}`,
    `GITHUB_TOKEN=${bearer} x-api-key=${headerValue}`,
    `OPENAI_API_KEY="${envToken}"`,
    `note: ${bearer} and again ${bearer}`,
    `path=/home/dave/.codex/auth.json`,
  ].join("\n");

  const output = redact(input);
  assertNoSecret(output, [bearer, headerValue, envToken, "/home/dave/.codex/auth.json"]);
  assert.ok(output.includes("x-api-key="));
  assert.ok(output.includes("path="));
  // Repeated redaction cannot resurrect a credential or mangle the line further.
  assert.equal(redact(output), output);
});

test("leaves benign log lines byte-identical", () => {
  const benign = [
    '{"event":"request","method":"GET","route":"/health","statusCode":200}',
    '{"event":"request","method":"GET","route":"/api/runs/:runId","statusCode":200}',
    '{"event":"run.accepted","runId":"run-6f1e0a2c","source":"fixture"}',
    '{"event":"run.finished","runId":"run-6f1e0a2c","source":"fixture","statusCode":201,"durationMs":12}',
    '{"event":"server.started","mode":"fixture","host":"127.0.0.1","port":8787}',
    '{"event":"run.rejected","reason":"run_in_progress"}',
    '{"event":"request.rejected","reason":"client_error","statusCode":400}',
    "token budget exhausted after 1000 steps",
    "the reviewer listed the api key rotation policy",
    "run-6f1e0a2c finished in 12ms with 3 hypotheses",
  ];

  for (const [index, line] of benign.entries()) {
    assert.equal(redact(line), line, `benign line ${index} was rewritten`);
  }
});

test("handles boundary inputs without leaking or crashing", () => {
  const token = fakeToken("ghp_", 36);

  // Nothing to redact: an empty value stays untouched.
  assert.equal(redact("GITHUB_TOKEN="), "GITHUB_TOKEN=");
  assert.equal(redact("GITHUB_TOKEN=[REDACTED]"), "GITHUB_TOKEN=[REDACTED]");
  assert.equal(redact('GITHUB_TOKEN="[REDACTED]"'), 'GITHUB_TOKEN="[REDACTED]"');
  assert.equal(redact(""), "");

  // Multi-line payloads keep their structure.
  const multiline = `server started\nAuthorization: Bearer ${token}\nGITHUB_TOKEN=${token}\nserver stopped`;
  const output = redact(multiline);
  assertNoSecret(output, [token]);
  assert.equal(output.split("\n").length, 4);
  assert.ok(output.startsWith("server started\n"));
  assert.ok(output.endsWith("\nserver stopped"));

  // A very long credential is still removed.
  const long = fakeToken("ghp_", 4096);
  assertNoSecret(redact(`token=${long}`), [long], "long credential");
  assertNoSecret(redact(`{"value":"${long}"}`), [long], "long credential in json");
});

test("fails closed when redaction cannot be applied", () => {
  assert.throws(() => redact(Symbol("boom") as unknown as string), TypeError);
  assert.throws(() => redact(undefined as unknown as string), TypeError);

  assert.equal(redactLine(Symbol("boom") as unknown as string), REDACTION_FAILURE_LINE);
  assert.equal(redactLine(undefined as unknown as string), REDACTION_FAILURE_LINE);

  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.equal(serializeLogLine(circular), REDACTION_FAILURE_LINE);
  assert.equal(serializeLogLine(undefined), REDACTION_FAILURE_LINE);
  assert.equal(serializeLogLine(() => "nope"), REDACTION_FAILURE_LINE);

  // The fallback carries no input-derived text at all.
  assert.ok(REDACTION_FAILURE_LINE.endsWith("\n"));
  assert.equal(REDACTION_FAILURE_LINE.includes("undefined"), false);
  assert.equal(REDACTION_FAILURE_LINE.includes("Symbol"), false);
});

/** Runs the real writeLog sink in a child process and returns everything it printed. */
const PROBE_SCRIPT = [
  'import { writeLog } from "./src/main.ts";',
  "const secrets = JSON.parse(process.env.TG_PROBE_SECRETS);",
  "const records = [",
  '  { event: "run.accepted", runId: secrets.githubToken, source: "fixture" },',
  '  { event: "request", method: "GET", route: "Authorization: Bearer " + secrets.bearerToken, statusCode: 200 },',
  '  { event: "request", method: "POST", route: "x-api-key=" + secrets.headerValue, statusCode: 400 },',
  '  { event: "request", method: "GET", route: secrets.codexPath, statusCode: 404 },',
  '  { event: "run.rejected", reason: "run_failed" },',
  '  { event: "server.failed", reason: "listen", toJSON() { throw new Error("unserializable " + secrets.headerValue); } },',
  "];",
  "for (const record of records) writeLog(record);",
].join("\n");

type ProbeResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

const runWriteLogProbe = (secrets: Readonly<Record<string, string>>): Promise<ProbeResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", PROBE_SCRIPT], {
      cwd: APP_ROOT,
      env: { ...process.env, TG_PROBE_SECRETS: JSON.stringify(secrets) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

test("writeLog redacts every record before it reaches stdout", async () => {
  const secrets = {
    githubToken: fakeToken("ghp_", 36),
    bearerToken: fakeToken("sk-ant-", 24),
    headerValue: fakeToken("Z", 24),
    codexPath: "/home/alice/.codex/auth.json",
  };
  const output = await runWriteLogProbe(secrets);

  assert.equal(output.code, 0, "the log sink crashed instead of failing closed");
  assertNoSecret(output.stdout, Object.values(secrets), "stdout");
  assertNoSecret(output.stderr, Object.values(secrets), "stderr");

  // Benign records are still written byte for byte, and context survives redaction.
  assert.ok(output.stdout.includes(JSON.stringify({ event: "run.rejected", reason: "run_failed" })));
  assert.ok(output.stdout.includes("Authorization: Bearer [REDACTED]"));
  assert.ok(output.stdout.includes("x-api-key=[REDACTED]"));
  assert.ok(output.stdout.includes("run.accepted"));

  // The unserializable record produced the fixed fail-closed marker, not raw text.
  assert.ok(output.stdout.split("\n").includes(REDACTION_FAILURE_LINE.trim()));

  // Every emitted line is still parseable JSON.
  for (const line of output.stdout.split("\n").filter((entry) => entry.length > 0)) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test("the server log sink redacts records before the listener sees them", async () => {
  const secretRunId = fakeToken("ghp_", 36);
  const records: RunLogRecord[] = [];
  const executor = createDefaultExecutor();
  const app = buildServer({
    mode: "fixture",
    log: (record) => records.push(record),
    executeRun: async (task) => ({ ...(await executor(task)), runId: secretRunId }),
  });

  try {
    const accepted = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { source: "fixture" },
    });
    assert.equal(accepted.statusCode, 201);
  } finally {
    await app.close();
  }

  assert.deepEqual(
    records
      .filter((record) => record.event === "run.accepted" || record.event === "run.finished")
      .map((record) => record.event),
    ["run.accepted", "run.finished"],
  );
  const finishedRunIds = records
    .filter((record) => record.event === "run.finished")
    .map((record) => (record.event === "run.finished" ? record.runId : ""));
  assert.deepEqual(finishedRunIds, [REDACTED]);
  assertNoSecret(JSON.stringify(records), [secretRunId], "captured records");
});

test("the record sink redacts nested fields and passes benign records through by reference", () => {
  const token = fakeToken("ghp_", 36);
  const received: { detail: string; nested: { list: string[]; count: number } }[] = [];
  const sink = createRedactingSink<{ detail: string; nested: { list: string[]; count: number } }>((record) =>
    received.push(record),
  );

  sink({ detail: `leaked ${token}`, nested: { list: [`Bearer ${token}`, "safe"], count: 2 } });
  const first = received[0];
  assert.ok(first !== undefined);
  assertNoSecret(JSON.stringify(first), [token], "sink record");
  assert.deepEqual(JSON.parse(JSON.stringify(first)), {
    detail: `leaked ${REDACTED}`,
    nested: { list: [`Bearer ${REDACTED}`, "safe"], count: 2 },
  });

  const benign = { detail: "nothing to hide", nested: { list: ["safe"], count: 2 } };
  assert.equal(redactRecord(benign), benign, "a benign record was copied");
  assert.equal(redactRecord("plain text"), "plain text");
});

test("redacts a doubled scheme prefix instead of taking it for the value", () => {
  const raw = fakeSecret("S3cr3tV4lue", "-", "DoNotLeak", "-9f2b");
  const b64 = fakeSecret("dXNlcjpwYXNz", "d29yZA==");
  const ghp = fakeToken("ghp_", 36);

  const cases: readonly (readonly [string, string, string])[] = [
    [`Authorization: Bearer Bearer ${raw}`, raw, "Authorization: Bearer Bearer [REDACTED]"],
    [`authorization: bearer bearer ${raw}`, raw, "authorization: bearer bearer [REDACTED]"],
    [`AUTHORIZATION: BEARER BEARER ${raw}`, raw, "AUTHORIZATION: BEARER BEARER [REDACTED]"],
    [`authorization=bearer bearer ${raw}`, raw, "authorization=bearer bearer [REDACTED]"],
    [`Authorization: Basic Basic ${b64}`, b64, "Authorization: Basic Basic [REDACTED]"],
    [`Authorization: Bearer Bearer ${ghp}`, ghp, "Authorization: Bearer Bearer [REDACTED]"],
    [`Authorization: Bearer Bearer Bearer ${raw}`, raw, "Authorization: Bearer Bearer Bearer [REDACTED]"],
    [`{"route":"Authorization: Bearer Bearer ${raw}"}`, raw, '{"route":"Authorization: Bearer Bearer [REDACTED]"}'],
  ];

  cases.forEach(([line, secret, expected], index) => {
    const output = redact(line);
    assertNoSecret(output, [secret], `doubled scheme ${index}`);
    assert.equal(output, expected, `doubled scheme ${index} did not keep its shape`);
    // Re-redacting an already redacted line must neither resurrect nor rewrite anything.
    assert.equal(redact(output), output, `doubled scheme ${index} is not idempotent`);
  });
});

test("keeps the single scheme prefix on the existing fast path", () => {
  const token = fakeToken("ghp_", 36);
  const single = `Authorization: Bearer ${token}`;

  assert.equal(redact(single), "Authorization: Bearer [REDACTED]");
  assert.equal(redact(`Authorization: Basic ${token}`), "Authorization: Basic [REDACTED]");
  assert.equal(redact(`Bearer ${token}`), "Bearer [REDACTED]");
  assert.equal(redact(redact(single)), redact(single));
});
