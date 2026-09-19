import assert from "node:assert/strict";
import test from "node:test";

import {
  LlmGatewayError,
  createLlmClient,
  parseStructuredJson,
  type CodexTransport,
  type LlmRequest,
} from "../src/index.js";

const request: LlmRequest = {
  system: "Return only a security finding.",
  messages: [{ role: "user", content: "Review this diff." }],
  maxTokens: 321,
  temperature: 0.2,
};

test("OpenAI-compatible provider uses its configured endpoint and bearer secret", async () => {
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    observedUrl = String(input);
    observedInit = init;
    return Response.json({
      model: "review-model",
      choices: [{ message: { content: "safe" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  };

  const client = createLlmClient(
    {
      id: "openai-custom",
      kind: "openai-compatible",
      baseUrl: "https://llm.example/v1/",
      model: "review-model",
      apiKeyEnv: "TEST_OPENAI_KEY",
    },
    { fetch: fetchImpl, env: { TEST_OPENAI_KEY: "top-secret" } },
  );

  const result = await client.generate(request);

  assert.equal(observedUrl, "https://llm.example/v1/chat/completions");
  const headers = new Headers(observedInit?.headers);
  assert.equal(headers.get("authorization"), "Bearer top-secret");
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(observedInit?.body));
  assert.deepEqual(body.messages, [
    { role: "system", content: request.system },
    ...request.messages,
  ]);
  assert.equal(body.max_tokens, 321);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.stream, false);
  assert.deepEqual(result, {
    providerId: "openai-custom",
    model: "review-model",
    text: "safe",
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
  });
});

test("OpenAI-compatible provider fails closed when a configured secret is absent", async () => {
  let called = false;
  const client = createLlmClient(
    {
      id: "openai-custom",
      kind: "openai-compatible",
      baseUrl: "https://llm.example/v1",
      model: "review-model",
      apiKeyEnv: "MISSING_KEY",
    },
    {
      fetch: async () => {
        called = true;
        return Response.json({});
      },
      env: {},
    },
  );

  await assert.rejects(
    client.generate(request),
    (error: unknown) =>
      error instanceof LlmGatewayError && error.code === "missing_secret",
  );
  assert.equal(called, false);
});

test("Anthropic-compatible provider uses Messages API headers and body", async () => {
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const client = createLlmClient(
    {
      id: "claude-custom",
      kind: "anthropic-compatible",
      baseUrl: "https://claude.example/v1",
      model: "claude-review",
      apiKeyEnv: "TEST_ANTHROPIC_KEY",
      anthropicVersion: "2023-06-01",
    },
    {
      env: { TEST_ANTHROPIC_KEY: "anthropic-secret" },
      fetch: async (input, init) => {
        observedUrl = String(input);
        observedInit = init;
        return Response.json({
          model: "claude-review",
          stop_reason: "end_turn",
          content: [
            { type: "text", text: "finding " },
            { type: "text", text: "confirmed" },
          ],
          usage: { input_tokens: 8, output_tokens: 3 },
        });
      },
    },
  );

  const result = await client.generate(request);

  assert.equal(observedUrl, "https://claude.example/v1/messages");
  const headers = new Headers(observedInit?.headers);
  assert.equal(headers.get("x-api-key"), "anthropic-secret");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  const body = JSON.parse(String(observedInit?.body));
  assert.equal(body.system, request.system);
  assert.deepEqual(body.messages, request.messages);
  assert.equal(body.max_tokens, 321);
  assert.equal(body.stream, false);
  assert.deepEqual(result, {
    providerId: "claude-custom",
    model: "claude-review",
    text: "finding confirmed",
    finishReason: "end_turn",
    usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
  });
});

test("Codex OAuth uses the injected OAuth transport without handling raw tokens", async () => {
  let observedPath = "";
  let observedInit: RequestInit | undefined;
  let observedOptions: unknown;
  const transport: CodexTransport = {
    request: async (path, init) => {
      observedPath = path;
      observedInit = init;
      return Response.json({
        model: "gpt-5.4-mini",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "oauth result" }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
      });
    },
  };

  const client = createLlmClient(
    {
      id: "codex-local",
      kind: "openai-codex-oauth",
      model: "gpt-5.4-mini",
      authFilePath: "/home/student/.codex/auth.json",
    },
    {
      createCodexTransport: async (options) => {
        observedOptions = options;
        return transport;
      },
    },
  );

  const result = await client.generate(request);

  assert.deepEqual(observedOptions, {
    authFilePath: "/home/student/.codex/auth.json",
  });
  assert.equal(observedPath, "/responses");
  const headers = new Headers(observedInit?.headers);
  assert.equal(headers.has("authorization"), false);
  const body = JSON.parse(String(observedInit?.body));
  assert.equal(body.model, "gpt-5.4-mini");
  assert.equal(body.instructions, request.system);
  assert.deepEqual(body.input, request.messages);
  assert.equal(body.max_output_tokens, 321);
  assert.equal(body.stream, false);
  assert.equal(result.text, "oauth result");
});

test("remote plaintext provider URLs are rejected, while loopback HTTP is allowed", () => {
  assert.throws(
    () =>
      createLlmClient({
        id: "unsafe",
        kind: "openai-compatible",
        baseUrl: "http://llm.example/v1",
        model: "model",
      }),
    (error: unknown) =>
      error instanceof LlmGatewayError && error.code === "insecure_endpoint",
  );

  assert.doesNotThrow(() =>
    createLlmClient({
      id: "local",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "model",
    }),
  );
});

test("provider errors are bounded and do not echo request secrets", async () => {
  const client = createLlmClient(
    {
      id: "broken",
      kind: "openai-compatible",
      baseUrl: "https://llm.example/v1",
      model: "model",
      apiKeyEnv: "KEY",
    },
    {
      env: { KEY: "never-log-me" },
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { message: `bad request ${"x".repeat(1_000)}` } }),
          { status: 400 },
        ),
    },
  );

  await assert.rejects(client.generate(request), (error: unknown) => {
    assert.ok(error instanceof LlmGatewayError);
    assert.equal(error.code, "upstream_error");
    assert.equal(error.message.includes("never-log-me"), false);
    assert.ok(error.message.length < 400);
    return true;
  });
});

test("structured JSON parsing accepts exact JSON and validates its domain shape", () => {
  const parsed = parseStructuredJson(
    '{"severity":"high","confirmed":true}',
    (value): value is { severity: string; confirmed: boolean } => {
      if (typeof value !== "object" || value === null) return false;
      const candidate = value as Record<string, unknown>;
      return (
        typeof candidate.severity === "string" &&
        typeof candidate.confirmed === "boolean"
      );
    },
  );

  assert.deepEqual(parsed, { severity: "high", confirmed: true });
  assert.throws(
    () =>
      parseStructuredJson(
        'prefix {"confirmed":true}',
        (_value): _value is unknown => true,
      ),
    (error: unknown) =>
      error instanceof LlmGatewayError && error.code === "invalid_model_output",
  );
});
