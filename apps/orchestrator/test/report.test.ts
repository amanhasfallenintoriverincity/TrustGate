import assert from "node:assert/strict";
import test from "node:test";

import type { AnalysisPlan, ExecutionResult } from "@trustgate/contracts";

import {
  REPORT_MAX_BYTES,
  createRunReport,
  type ReportInput,
} from "../src/report.js";

const baseHypothesis: AnalysisPlan["hypotheses"][number] = {
  id: "price-authority",
  title: "Server controls item prices",
  category: "price-tampering",
  severity: "high",
  evidence: [
    {
      file: "apps/demo-target/src/store.ts",
      line: 7,
      excerpt: "price = request.price",
    },
  ],
  tests: [
    {
      id: "negative-price",
      request: {
        method: "POST",
        path: "/api/purchase",
        body: { itemId: "sword", price: -100 },
      },
      assertions: [{ kind: "status", equals: 400 }],
    },
  ],
};

const result = (
  testId: string,
  verdict: ExecutionResult["verdict"],
  hypothesisId = "price-authority",
): ExecutionResult => ({
  runId: `spec-${testId}`,
  hypothesisId,
  verdict,
  executed: verdict === "CONFIRMED" || verdict === "BLOCKED",
  evidence:
    verdict === "CONFIRMED"
      ? [{ kind: "status", expected: 400, actual: 200 }]
      : verdict === "BLOCKED"
        ? []
        : [{ kind: "execution-error", expected: "executed", actual: "failed" }],
});

const fakeSecret = (...parts: string[]): string => parts.join("");

const fakeToken = (prefix: string, length = 20): string =>
  `${prefix}${"A".repeat(length)}`;

const makeInput = (): ReportInput => ({
  runId: "run-1",
  provider: "openai-compatible",
  model: "example/model-1.0",
  reviewedFiles: ["apps/demo-target/src/store.ts"],
  hypotheses: [structuredClone(baseHypothesis)],
  vulnerableResults: [result("negative-price", "CONFIRMED")],
  patchedResults: [result("negative-price", "BLOCKED")],
  durations: {
    totalMs: 100,
    ocrMs: 10,
    planningMs: 20,
    vulnerableMs: 30,
    patchedMs: 40,
  },
});

const rejectionMessage = (input: ReportInput): string => {
  try {
    createRunReport(input);
    assert.fail("expected report rejection");
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
};

const addTest = (
  hypothesis: AnalysisPlan["hypotheses"][number],
  id: string,
): void => {
  hypothesis.tests.push({
    id,
    request: { method: "GET", path: `/api/${id}` },
    assertions: [{ kind: "status", equals: 403 }],
  });
};

const setRequestBody = (input: ReportInput, value: unknown): void => {
  const request = input.hypotheses[0]!.tests[0]!.request as unknown as Record<
    string,
    unknown
  >;
  request.body = value;
};

test("report joins results into hypotheses and exposes fixed regressions", () => {
  const report = createRunReport(makeInput());
  const hypothesis = report.hypotheses[0];
  const regression = hypothesis?.tests[0];

  assert.equal(hypothesis?.id, "price-authority");
  assert.equal(regression?.id, "negative-price");
  assert.equal(regression?.vulnerableResult.runId, "spec-negative-price");
  assert.equal(regression?.patchedResult.verdict, "BLOCKED");
  assert.equal(regression?.regressionVerdict, "FIXED");
  assert.equal(hypothesis?.regressionVerdict, "FIXED");
  assert.equal(report.regressionVerdict, "FIXED");
  assert.deepEqual(Object.keys(report), [
    "runId",
    "provider",
    "model",
    "reviewedFiles",
    "hypotheses",
    "vulnerableResults",
    "patchedResults",
    "regressionVerdict",
    "durations",
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(report), "utf8") <= REPORT_MAX_BYTES);
});

test("multi-test hypotheses aggregate with fail-closed precedence", () => {
  const input = makeInput();
  const hypothesis = input.hypotheses[0]!;
  addTest(hypothesis, "still-open");
  addTest(hypothesis, "never-reproduced");
  addTest(hypothesis, "could-not-run");
  input.vulnerableResults = [
    result("negative-price", "CONFIRMED"),
    result("still-open", "CONFIRMED"),
    result("never-reproduced", "BLOCKED"),
    result("could-not-run", "ERROR"),
  ];
  input.patchedResults = [
    result("negative-price", "BLOCKED"),
    result("still-open", "CONFIRMED"),
    result("never-reproduced", "BLOCKED"),
    result("could-not-run", "BLOCKED"),
  ];

  const report = createRunReport(input);

  assert.deepEqual(
    report.hypotheses[0]?.tests.map(({ regressionVerdict }) => regressionVerdict),
    ["FIXED", "STILL_VULNERABLE", "NOT_REPRODUCED", "UNVERIFIED"],
  );
  assert.equal(report.hypotheses[0]?.regressionVerdict, "UNVERIFIED");
  assert.equal(report.regressionVerdict, "UNVERIFIED");

  input.vulnerableResults.pop();
  input.patchedResults.pop();
  hypothesis.tests.pop();
  const stillVulnerable = createRunReport(input);
  assert.equal(
    stillVulnerable.hypotheses[0]?.regressionVerdict,
    "STILL_VULNERABLE",
  );
  assert.equal(stillVulnerable.regressionVerdict, "STILL_VULNERABLE");
  input.vulnerableResults.splice(1, 1);
  input.patchedResults.splice(1, 1);
  hypothesis.tests.splice(1, 1);
  const fixed = createRunReport(input);
  assert.equal(fixed.hypotheses[0]?.regressionVerdict, "FIXED");
  assert.equal(fixed.regressionVerdict, "FIXED");
  input.vulnerableResults[0] = result("negative-price", "BLOCKED");
  const notReproduced = createRunReport(input);
  assert.equal(
    notReproduced.hypotheses[0]?.regressionVerdict,
    "NOT_REPRODUCED",
  );
  assert.equal(notReproduced.regressionVerdict, "NOT_REPRODUCED");
});

test("report rejects malformed duplicate missing unknown and out-of-order identities", () => {
  const scenarios: Array<[string, (input: ReportInput) => void]> = [
    ["malformed run id", (input) => { input.vulnerableResults[0]!.runId = "negative-price"; }],
    ["wrong hypothesis", (input) => { input.patchedResults[0]!.hypothesisId = "unknown-hypothesis"; }],
    ["missing result", (input) => { input.vulnerableResults = []; }],
    ["extra result", (input) => { input.patchedResults.push(result("unknown-test", "BLOCKED")); }],
    [
      "duplicate identity",
      (input) => {
        addTest(input.hypotheses[0]!, "second-test");
        input.vulnerableResults.push(result("negative-price", "BLOCKED"));
        input.patchedResults.push(result("second-test", "BLOCKED"));
      },
    ],
    [
      "out of order",
      (input) => {
        addTest(input.hypotheses[0]!, "second-test");
        input.vulnerableResults = [
          result("second-test", "BLOCKED"),
          result("negative-price", "CONFIRMED"),
        ];
        input.patchedResults.push(result("second-test", "BLOCKED"));
      },
    ],
  ];

  for (const [name, mutate] of scenarios) {
    const input = makeInput();
    mutate(input);
    assert.equal(rejectionMessage(input), "run report rejected", name);
  }
});

test("report rejects invalid reviewed file lists and public metadata", () => {
  const badPaths = [
    "/home/user/repo/src/store.ts",
    "../secret.txt",
    "src/../secret.txt",
    "src//store.ts",
    "src\\store.ts",
    ".env",
    "config/.env.production",
    "home/.codex/auth.json",
    "cert/private.pem",
    "cert/private.key",
    "token.txt",
  ];
  for (const path of badPaths) {
    const input = makeInput();
    input.reviewedFiles = [path];
    assert.equal(rejectionMessage(input), "run report rejected", path);
  }

  const empty = makeInput();
  empty.reviewedFiles = [];
  assert.equal(rejectionMessage(empty), "run report rejected");
  const duplicate = makeInput();
  duplicate.reviewedFiles.push(duplicate.reviewedFiles[0]!);
  assert.equal(rejectionMessage(duplicate), "run report rejected");
  const tooMany = makeInput();
  tooMany.reviewedFiles = Array.from({ length: 65 }, (_, index) => `src/file-${index}.ts`);
  assert.equal(rejectionMessage(tooMany), "run report rejected");

  for (const field of ["runId", "provider", "model"] as const) {
    for (const value of [
      "",
      "x".repeat(129),
      "line\nbreak",
      "Authorization: Bearer report-secret",
      "x-api-key=report-secret",
      fakeSecret("GITHUB_TOKEN=", "gh", "p_report_secret"),
      "/home/user/.codex/auth.json",
      "report-secret",
    ]) {
      const input = makeInput();
      input[field] = value;
      assert.equal(rejectionMessage(input), "run report rejected", `${field}: ${value}`);
    }
  }
});

for (const path of [".", "..", "src/.", "src/..", "src/./file.ts", "src/../file.ts"]) {
  test(`report rejects reviewed file dot segment: ${path}`, () => {
    const input = makeInput();
    input.reviewedFiles = [path];

    assert.equal(rejectionMessage(input), "run report rejected");
  });
}

test("report rejects a raw prompt marker in hypothesis evidence", () => {
  const input = makeInput();
  input.hypotheses[0]!.evidence[0]!.excerpt = "raw-prompt-marker";

  assert.equal(rejectionMessage(input), "run report rejected");
});

const sensitiveBodyKeys = [
  "prompt",
  "systemPrompt",
  "user_prompt",
  "developer-prompt",
  "rawPrompt",
  "analysisPrompt",
  "system-prompt",
  "userPromptText",
  "developer_prompt_value",
  "raw-prompt-input",
  "authorization",
  "authorizationHeader",
  "x-api-key",
  "api-key",
  "apiKey",
  "OPENAI_API_KEY",
  "token",
  "session_token",
  "accessToken",
  "refresh_token",
  "oauthToken",
  "oauthPath",
  "auth_path",
  "repoPath",
  "env",
  "environment",
  "rawError",
  "error_detail",
  "errorMessage",
  "errorStack",
  "credential",
  "credentials",
  "db_password",
  "password",
  "passwd",
  "secret",
  "githubToken",
  "client-secret",
  "privateKey",
  "apiKeyMetadata",
  "sessionTokenValue",
  "oauthTokenValue",
  "secretariatToken",
  "environmentName",
  "accessKeyId",
  "secretAccessKey",
] as const;

for (const key of sensitiveBodyKeys) {
  test(`report rejects sensitive nested request body key: ${key}`, () => {
    const input = makeInput();
    input.hypotheses[0]!.tests[0]!.request.body = {
      [key]: "public-example",
    };

    assert.equal(rejectionMessage(input), "run report rejected");
  });
}

const sensitiveBodyValues = [
  ["API key marker", fakeSecret("api-", "key-marker")],
  // Keep synthetic credential examples constructed at runtime so scanners never see a token literal.
  [
    "OpenAI-style API key",
    fakeToken(fakeSecret("s", "k-"), "A".repeat(12).length),
  ],
  ["GitHub token", fakeToken(fakeSecret("gh", "p_"))],
  ["GitLab token", fakeToken(fakeSecret("gl", "pat-"))],
  ["Slack token", fakeToken(fakeSecret("xo", "xb-"))],
  [
    "JWT credential",
    fakeSecret(
      "eyJ",
      "hbGciOiJIUzI1NiJ9.",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
      "signature123",
    ),
  ],
  ["short Bearer credential", "Bearer abc used by caller"],
  ["OAuth credential path", "config/.codex/auth.json"],
  ["generic auth file path", "config/auth.json"],
  ["absolute Linux repository path", "/home/user/private/repo"],
  ["embedded Linux repository path", "prefix /home/user/private/repo suffix"],
  ["relative home path", "prefix ~/.ssh/id_ed25519 suffix"],
  ["relative AWS path", "prefix ~/.aws/credentials suffix"],
  ["root repository path", "/root/private/repo"],
  ["temporary secret path", "/tmp/secret"],
  ["variable-data secret path", "stored at /var/lib/private/report.json"],
  ["optional software secret path", "stored at /opt/private/report.json"],
  ["system configuration path", "stored at /etc/private/report.json"],
  ["home config path", "HOME/.aws/credentials"],
  ["token environment marker", "GITHUB_TOKEN=token-marker"],
  ["session token assignment", "session_token=session-marker"],
  ["OAuth token assignment", "oauthToken=oauth-marker"],
  ["database password assignment", "db_password=password-marker"],
  ["client secret assignment", "clientSecret=secret-marker"],
  ["dotenv path", "config/.env.production"],
  ["PEM path", "cert/private.pem"],
  ["embedded PEM path", "certificate saved at cert/private.pem for later"],
  ["private key path", "cert/private.key"],
  ["private key basename path", "keys/private-key"],
  ["AWS access key id", fakeSecret("AK", "IAIOSFODNN7EXAMPLE")],
  ["AWS secret access key", fakeSecret("AWS_SECRET_", "ACCESS_KEY=example-secret-value")],
  ["OpenSSH private key path", "keys/id_ed25519"],
  ["macOS home path", "/Users/example/private/repo"],
  ["embedded macOS home path", "prefix /Users/example/private/repo suffix"],
  ["Windows drive path", "C:\\Users\\example\\private\\repo"],
  ["embedded Windows drive path", "prefix C:\\Users\\example\\private\\repo suffix"],
  ["Windows UNC path", "\\\\server\\share\\private\\repo"],
] as const;

for (const [name, value] of sensitiveBodyValues) {
  test(`report rejects sensitive nested request body value: ${name}`, () => {
    const input = makeInput();
    input.hypotheses[0]!.tests[0]!.request.body = { note: value };

    assert.equal(rejectionMessage(input), "run report rejected");
  });
}

for (const side of ["vulnerable", "patched"] as const) {
  for (const field of ["expected", "actual"] as const) {
    for (const value of [
      "raw-error-marker",
      "credential=credential-marker",
    ] as const) {
      test(`report rejects ${side} execution evidence ${field}: ${value}`, () => {
        const input = makeInput();
        const results =
          side === "vulnerable" ? input.vulnerableResults : input.patchedResults;
        if (side === "patched") {
          results[0] = result("negative-price", "ERROR");
        }
        results[0]!.evidence[0]![field] = value;

        assert.equal(rejectionMessage(input), "run report rejected");
      });
    }
  }
}

test("report rejects raw prompt and error marker variants", () => {
  for (const value of [
    "raw-prompt-marker",
    "raw-system-prompt-marker",
    "raw-user-prompt-marker",
    "raw-developer-prompt-marker",
    "raw-error-marker",
    "raw-error-detail-marker",
    "raw-error-message-marker",
    "raw-error-stack-marker",
  ]) {
    const input = makeInput();
    input.hypotheses[0]!.evidence[0]!.excerpt = value;
    assert.equal(rejectionMessage(input), "run report rejected", value);
  }
});

test("report preserves safe security language and valid API paths", () => {
  const input = makeInput();
  const hypothesis = input.hypotheses[0]!;
  const spec = hypothesis.tests[0]!;
  hypothesis.title = "Missing authorization check";
  hypothesis.evidence[0]!.excerpt =
    "API key rotation and Bearer authentication use passwordless credentialing; prompt reviewers carefully";
  spec.request.path = "/api/token/refresh";
  spec.request.body = {
    tokenCount: 2,
    tokenizer: "public tokenizer",
    passwordless: true,
    credentialing: "training",
    secretariat: "office",
  };
  input.vulnerableResults[0] = result("negative-price", "ERROR");
  input.patchedResults[0] = result("negative-price", "ERROR");

  const report = createRunReport(input);

  assert.equal(report.hypotheses[0]?.title, "Missing authorization check");
  assert.equal(report.hypotheses[0]?.category, "price-tampering");
  assert.equal(report.hypotheses[0]?.tests[0]?.request.path, "/api/token/refresh");
  assert.equal(report.hypotheses[0]?.tests[0]?.assertions[0]?.kind, "status");
  assert.equal(
    report.vulnerableResults[0]?.evidence[0]?.kind,
    "execution-error",
  );
  assert.equal(report.regressionVerdict, "UNVERIFIED");
});

test("report accepts safe source filenames that contain security-language stems", () => {
  const input = makeInput();
  input.reviewedFiles = [
    "src/passwordless.ts",
    "src/credentialing.ts",
    "src/token.ts",
    "src/authorization.ts",
  ];
  input.hypotheses[0]!.tests[0]!.request.body = {
    tokenCount: 1,
    tokenizer: "public",
    passwordless: true,
    credentialing: "training",
    secretariat: "office",
    environmentalImpact: "low",
  };

  assert.deepEqual(createRunReport(input).reviewedFiles, input.reviewedFiles);
});

const jsonOriginViolations: ReadonlyArray<readonly [string, () => unknown]> = [
  ["undefined property", () => ({ safe: "value", omitted: undefined })],
  ["function property", () => ({ safe: "value", omitted: () => "hidden" })],
  ["symbol value", () => ({ safe: "value", omitted: Symbol("hidden") })],
  ["bigint value", () => ({ safe: "value", count: 1n })],
  ["NaN value", () => ({ value: Number.NaN })],
  ["positive infinity", () => ({ value: Number.POSITIVE_INFINITY })],
  ["negative infinity", () => ({ value: Number.NEGATIVE_INFINITY })],
  ["Date instance", () => new Date("2026-01-01T00:00:00.000Z")],
  [
    "class instance",
    () => {
      class Payload {
        readonly safe = "value";
      }
      return new Payload();
    },
  ],
  [
    "custom prototype",
    () => Object.assign(Object.create({ inherited: "value" }), { safe: "value" }),
  ],
  [
    "null prototype",
    () => Object.assign(Object.create(null) as object, { safe: "value" }),
  ],
  ["sparse array", () => Object.assign(new Array<unknown>(2), { 0: "value" })],
  [
    "inherited array index",
    () => {
      const value = new Array<unknown>(1);
      const inheritedIndex = Object.create(Array.prototype) as unknown[];
      Object.defineProperty(inheritedIndex, "0", {
        configurable: true,
        enumerable: true,
        value: "inherited",
      });
      Object.setPrototypeOf(value, inheritedIndex);
      return value;
    },
  ],
  [
    "non-enumerable property",
    () => {
      const value = { safe: "value" };
      Object.defineProperty(value, "hidden", { value: "hidden" });
      return value;
    },
  ],
  [
    "symbol-keyed property",
    () => ({ safe: "value", [Symbol("hidden")]: "hidden" }),
  ],
  [
    "non-enumerable toJSON method",
    () => {
      const value = { safe: "value" };
      Object.defineProperty(value, "toJSON", {
        value() {
          throw new Error("toJSON invoked");
        },
      });
      return value;
    },
  ],
  [
    "cycle",
    () => {
      const value: Record<string, unknown> = { safe: "value" };
      value.self = value;
      return value;
    },
  ],
];

for (const [name, makeValue] of jsonOriginViolations) {
  test(`report rejects non-JSON-origin input before normalization: ${name}`, () => {
    const input = makeInput();
    setRequestBody(input, makeValue());

    assert.equal(rejectionMessage(input), "run report rejected");
  });
}

test("report rejects accessors without invoking them", () => {
  const input = makeInput();
  let reads = 0;
  const value = { safe: "value" };
  Object.defineProperty(value, "computed", {
    enumerable: true,
    get() {
      reads += 1;
      return "value";
    },
  });
  setRequestBody(input, value);

  assert.equal(rejectionMessage(input), "run report rejected");
  assert.equal(reads, 0);
});

test("report rejects setter accessors without invoking attacker code", () => {
  const input = makeInput();
  let writes = 0;
  const value = { safe: "value" };
  Object.defineProperty(value, "computed", {
    enumerable: true,
    set(_next: unknown) {
      writes += 1;
    },
  });
  setRequestBody(input, value);

  assert.equal(rejectionMessage(input), "run report rejected");
  assert.equal(writes, 0);
});

test("report rejects a custom prototype before inspecting its own keys", () => {
  const input = makeInput();
  let ownKeyReads = 0;
  const value = new Proxy({ safe: "value" }, {
    getPrototypeOf() {
      return { custom: true };
    },
    ownKeys() {
      ownKeyReads += 1;
      return ["safe"];
    },
  });
  setRequestBody(input, value);

  assert.equal(rejectionMessage(input), "run report rejected");
  assert.equal(ownKeyReads, 0);
});

test("report rejects a top-level accessor without invoking it", () => {
  const input = makeInput();
  let reads = 0;
  Object.defineProperty(input, "runId", {
    enumerable: true,
    get() {
      reads += 1;
      return "run-1";
    },
  });

  assert.equal(rejectionMessage(input), "run report rejected");
  assert.equal(reads, 0);
});

test("report rejects toJSON methods without invoking them", () => {
  const input = makeInput();
  let calls = 0;
  const value = {
    toJSON() {
      calls += 1;
      return { safe: "value" };
    },
  };
  setRequestBody(input, value);

  assert.equal(rejectionMessage(input), "run report rejected");
  assert.equal(calls, 0);
});

test("report rejects secrets in deeply nested JSON values", () => {
  const input = makeInput();
  input.hypotheses[0]!.tests[0]!.request.body = {
    payload: [{ metadata: { note: "raw-prompt-marker" } }],
  };

  assert.equal(rejectionMessage(input), "run report rejected");
});

test("report preserves safe JSON at the contract depth bound", () => {
  const input = makeInput();
  let value: unknown = "public-example";
  for (let depth = 0; depth < 8; depth += 1) {
    value = { payload: value };
  }
  input.hypotheses[0]!.tests[0]!.request.body = value as NonNullable<
    AnalysisPlan["hypotheses"][number]["tests"][number]["request"]["body"]
  >;

  assert.deepEqual(
    createRunReport(input).hypotheses[0]?.tests[0]?.request.body,
    value,
  );
});

test("report preserves a schema-valid wide JSON body below the byte cap", () => {
  const input = makeInput();
  const value = Array.from({ length: 64 }, () =>
    Array.from({ length: 64 }, () => Array.from({ length: 3 }, () => false)),
  );
  input.hypotheses[0]!.tests[0]!.request.body = value;

  assert.deepEqual(
    createRunReport(input).hypotheses[0]?.tests[0]?.request.body,
    value,
  );
});

test("report validates schema bounds result states cardinality and durations", () => {
  const malformedPlan = makeInput();
  malformedPlan.hypotheses[0]!.title = "x";
  assert.equal(rejectionMessage(malformedPlan), "run report rejected");

  const duplicateHypotheses = makeInput();
  duplicateHypotheses.hypotheses.push(structuredClone(baseHypothesis));
  duplicateHypotheses.vulnerableResults.push(result("negative-price", "BLOCKED"));
  duplicateHypotheses.patchedResults.push(result("negative-price", "BLOCKED"));
  assert.equal(rejectionMessage(duplicateHypotheses), "run report rejected");

  const duplicateTests = makeInput();
  duplicateTests.hypotheses[0]!.tests.push(
    structuredClone(duplicateTests.hypotheses[0]!.tests[0]!),
  );
  duplicateTests.vulnerableResults.push(result("negative-price", "BLOCKED"));
  duplicateTests.patchedResults.push(result("negative-price", "BLOCKED"));
  assert.equal(rejectionMessage(duplicateTests), "run report rejected");

  const invalidResult = makeInput();
  invalidResult.vulnerableResults[0]!.executed = false;
  assert.equal(rejectionMessage(invalidResult), "run report rejected");

  const tooManyResults = makeInput();
  tooManyResults.vulnerableResults = Array.from({ length: 51 }, () =>
    result("negative-price", "CONFIRMED"),
  );
  assert.equal(rejectionMessage(tooManyResults), "run report rejected");

  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 86_400_001]) {
    const input = makeInput();
    input.durations.totalMs = value;
    assert.equal(rejectionMessage(input), "run report rejected", String(value));
  }
  const maxDuration = makeInput();
  for (const key of Object.keys(maxDuration.durations) as Array<keyof typeof maxDuration.durations>) {
    maxDuration.durations[key] = 86_400_000;
  }
  assert.equal(createRunReport(maxDuration).durations.totalMs, 86_400_000);
});

test("report snapshots input and returns no caller-owned references", () => {
  const input = makeInput();
  const before = structuredClone(input);
  const report = createRunReport(input);

  assert.deepEqual(input, before);
  assert.notStrictEqual(report.reviewedFiles, input.reviewedFiles);
  assert.notStrictEqual(report.hypotheses, input.hypotheses);
  assert.notStrictEqual(report.vulnerableResults, input.vulnerableResults);
  assert.notStrictEqual(report.patchedResults, input.patchedResults);
  assert.notStrictEqual(report.durations, input.durations);
  assert.notStrictEqual(
    report.hypotheses[0]?.tests[0],
    input.hypotheses[0]?.tests[0],
  );
  assert.notStrictEqual(
    report.hypotheses[0]?.evidence,
    input.hypotheses[0]?.evidence,
  );

  input.runId = "mutated-run";
  input.reviewedFiles[0] = "src/mutated.ts";
  input.hypotheses[0]!.title = "Mutated title";
  input.vulnerableResults[0]!.verdict = "BLOCKED";
  input.durations.totalMs = 999;
  assert.equal(report.runId, "run-1");
  assert.equal(report.reviewedFiles[0], "apps/demo-target/src/store.ts");
  assert.equal(report.hypotheses[0]?.title, "Server controls item prices");
  assert.equal(report.vulnerableResults[0]?.verdict, "CONFIRMED");
  assert.equal(report.durations.totalMs, 100);

  report.hypotheses[0]!.title = "Changed output";
  assert.equal(report.hypotheses[0]?.tests[0]?.regressionVerdict, "FIXED");
});

test("report output is deterministic JSON-safe and rejects secret-bearing extras", () => {
  const first = createRunReport(makeInput());
  const second = createRunReport(makeInput());
  const serialized = JSON.stringify(first);

  assert.equal(serialized, JSON.stringify(second));
  assert.deepEqual(JSON.parse(serialized), first);
  for (const secret of [
    fakeSecret("raw-", "prompt-marker"),
    fakeSecret("api-", "key-marker"),
    ".codex/auth.json",
    "/home/user/private/repo",
    fakeSecret("token-", "marker"),
    fakeSecret("raw-", "error-marker"),
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }

  const fields = {
    prompt: fakeSecret("raw-", "prompt-marker"),
    apiKey: fakeSecret("api-", "key-marker"),
    oauthPath: "/home/user/.codex/auth.json",
    repoPath: "/home/user/private/repo",
    env: { GITHUB_TOKEN: fakeSecret("token-", "marker") },
    rawError: fakeSecret("raw-", "error-marker"),
  } as const;
  for (const [field, value] of Object.entries(fields)) {
    const input = makeInput() as ReportInput & Record<string, unknown>;
    input[field] = value;
    assert.equal(rejectionMessage(input), "run report rejected", field);
  }
});

test("report direct bypass probes reject exactly and safe fixture survives", () => {
  const probes: ReadonlyArray<readonly [string, () => unknown]> = [
    ["x-api-key", () => ({ nested: { "x-api-key": "value" } })],
    ["db_password", () => ({ nested: { db_password: "value" } })],
    ["session_token", () => ({ nested: { session_token: "value" } })],
    ["oauthToken", () => ({ nested: { oauthToken: "value" } })],
    ["config/auth.json", () => ({ nested: "config/auth.json" })],
    ["/root path", () => ({ nested: "/root/private/repo" })],
    [
      "embedded /home path",
      () => ({ nested: "prefix /home/user/private/repo suffix" }),
    ],
    ["/tmp path", () => ({ nested: "/tmp/secret" })],
    ["undefined", () => ({ secret: undefined })],
    ["function", () => ({ apiKey: () => "hidden" })],
    ["NaN", () => ({ value: Number.NaN })],
    ["Date", () => new Date("2026-01-01T00:00:00.000Z")],
    [
      "toJSON",
      () => ({
        toJSON() {
          return { safe: "value" };
        },
      }),
    ],
    [
      "accessor",
      () => {
        const value = { safe: "value" };
        Object.defineProperty(value, "computed", {
          enumerable: true,
          get() {
            return "value";
          },
        });
        return value;
      },
    ],
    [
      "custom prototype",
      () => Object.assign(Object.create({ inherited: true }), { safe: "value" }),
    ],
    ["sparse array", () => Object.assign(new Array<unknown>(2), { 0: "value" })],
    [
      "cycle",
      () => {
        const value: Record<string, unknown> = { safe: "value" };
        value.self = value;
        return value;
      },
    ],
  ];

  for (const [name, makeValue] of probes) {
    const input = makeInput();
    setRequestBody(input, makeValue());
    assert.equal(rejectionMessage(input), "run report rejected", name);
  }

  assert.equal(createRunReport(makeInput()).regressionVerdict, "FIXED");
});

test("report rejects serialized output above one MiB", () => {
  const input = makeInput();
  const hypotheses: AnalysisPlan["hypotheses"] = [];
  const vulnerableResults: ExecutionResult[] = [];
  const patchedResults: ExecutionResult[] = [];

  for (let hypothesisIndex = 0; hypothesisIndex < 10; hypothesisIndex += 1) {
    const hypothesis = structuredClone(baseHypothesis);
    hypothesis.id = `hypothesis-${hypothesisIndex}`;
    hypothesis.title = `Large bounded hypothesis ${hypothesisIndex}`;
    hypothesis.evidence = Array.from({ length: 8 }, (_, evidenceIndex) => ({
      file: `src/${"f".repeat(480)}-${hypothesisIndex}-${evidenceIndex}.ts`,
      line: evidenceIndex + 1,
      excerpt: "e".repeat(300),
    }));
    hypothesis.tests = [];
    for (let testIndex = 0; testIndex < 5; testIndex += 1) {
      const testId = `test-${hypothesisIndex}-${testIndex}`;
      hypothesis.tests.push({
        id: testId,
        request: {
          method: "POST",
          path: `/api/${"p".repeat(490)}-${hypothesisIndex}-${testIndex}`,
          body: {
            payload: Array.from({ length: 64 }, (_, index) =>
              `${index}-${"x".repeat(16_370)}`,
            ),
          },
        },
        assertions: Array.from({ length: 8 }, () => ({
          kind: "json-equals" as const,
          path: `$.${"k".repeat(500)}`,
          equals: "y".repeat(16_384),
        })),
      });
      vulnerableResults.push(result(testId, "CONFIRMED", hypothesis.id));
      patchedResults.push(result(testId, "BLOCKED", hypothesis.id));
    }
    hypotheses.push(hypothesis);
  }
  input.hypotheses = hypotheses;
  input.vulnerableResults = vulnerableResults;
  input.patchedResults = patchedResults;

  assert.equal(rejectionMessage(input), "run report rejected");
});
