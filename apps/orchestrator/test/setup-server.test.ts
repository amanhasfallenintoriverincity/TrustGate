import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AnalysisPlan, ExecutionResult } from "@trustgate/contracts";

import fixturePlan from "../src/fixture-plan.json" with { type: "json" };
import { createSetupStore } from "../src/setup-store.js";
import { buildServer, type WorkspacePipeline } from "../src/server.js";

const headers = { host: "127.0.0.1:8787", origin: "http://localhost:5173" };
const settings = {
  kind: "openai-compatible" as const,
  baseUrl: "http://127.0.0.1:9999/v1",
  model: "model-one",
  apiKeyEnv: "",
  sandboxImage: "localhost/trustgate-target:latest",
};

const withStore = async (run: (store: ReturnType<typeof createSetupStore>) => Promise<void>) => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "trustgate-setup-api-"));
  try { await run(createSetupStore({ configPath: join(root, "trustgate", "config.json") })); }
  finally { await rm(root, { recursive: true, force: true }); }
};

test("fixture setup persists nonsecret config while workspace runs stay rejected", async () => {
  await withStore(async (setupStore) => {
    const app = buildServer({ mode: "fixture", setupStore });
    try {
      const before = await app.inject({ method: "GET", url: "/api/setup", headers });
      assert.equal(before.statusCode, 200);
      assert.deepEqual(before.json(), { mode: "fixture", configured: false, settings: null });
      const saved = await app.inject({ method: "POST", url: "/api/setup", headers, payload: settings });
      assert.equal(saved.statusCode, 200);
      assert.deepEqual(saved.json(), { mode: "fixture", configured: true, settings: { ...settings, keyAvailable: false } });
      assert.equal(saved.headers["cache-control"], "no-store");
      assert.deepEqual((await app.inject({ method: "GET", url: "/api/setup", headers })).json(), saved.json());
      assert.equal((await app.inject({ method: "POST", url: "/api/runs", payload: { source: "workspace" } })).statusCode, 400);
    } finally { await app.close(); }
  });
});

test("Codex OAuth setup reflects no credential readiness and connection test fails closed without login", async () => {
  await withStore(async (setupStore) => {
    const oauth = { ...settings, kind: "openai-codex-oauth", baseUrl: "", apiKeyEnv: "" };
    const app = buildServer({ mode: "workspace", setupStore });
    try {
      const saved = await app.inject({ method: "POST", url: "/api/setup", headers, payload: oauth });
      assert.equal(saved.statusCode, 200);
      assert.deepEqual(saved.json().settings, { ...oauth, keyAvailable: false });
      assert.deepEqual((await app.inject({ method: "GET", url: "/api/setup", headers })).json().settings, { ...oauth, keyAvailable: false });
    } finally { await app.close(); }
  });
});

test("Codex OAuth connection test uses gateway default auth and fixed failure without credentials", async () => {
  await withStore(async (setupStore) => {
    await setupStore.save({ ...settings, kind: "openai-codex-oauth", baseUrl: "", apiKeyEnv: "" });
    const app = buildServer({ mode: "workspace", setupStore });
    try {
      const result = await app.inject({ method: "POST", url: "/api/setup/test", headers, payload: {} });
      assert.equal(result.statusCode, 503);
      assert.deepEqual(result.json(), { error: "connection test failed" });
    } finally { await app.close(); }
  });
});

test("connection test makes one actual small chat completion call, never on save", async () => {
  await withStore(async (setupStore) => {
    const requests: Array<{ method: string | undefined; url: string | undefined; body: unknown }> = [];
    const provider = createServer((request, response) => {
      let body = "";
      request.on("data", (data: Buffer) => { body += data.toString(); });
      request.on("end", () => {
        requests.push({ method: request.method, url: request.url, body: JSON.parse(body) });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: "pong" }, finish_reason: "stop" }] }));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    assert.ok(address && typeof address !== "string");
    const app = buildServer({ mode: "workspace", setupStore });
    try {
      const saved = await app.inject({ method: "POST", url: "/api/setup", headers, payload: { ...settings, baseUrl: `http://127.0.0.1:${address.port}/v1` } });
      assert.equal(saved.statusCode, 200);
      assert.equal(requests.length, 0);
      const result = await app.inject({ method: "POST", url: "/api/setup/test", headers, payload: {} });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.json(), { ok: true });
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.url, "/v1/chat/completions");
      assert.equal((requests[0]?.body as { max_tokens: number }).max_tokens, 8);
      assert.equal(requests[0]?.method, "POST");
      assert.deepEqual((requests[0]?.body as { messages: unknown }).messages, [{ role: "user", content: "ping" }]);
    } finally { await app.close(); await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve())); }
  });
});

test("saving settings changes the workspace pipeline on the next run without restart", async () => {
  await withStore(async (setupStore) => {
    const seen: string[] = [];
    const app = buildServer({
      mode: "workspace",
      rootDir: process.cwd(),
      setupStore,
      createWorkspacePipelineForSettings: (_task, value) => {
        seen.push(`${value.model}:${value.sandboxImage}`);
        const pipeline: WorkspacePipeline = {
          provider: "setup-test",
          model: value.model,
          review: async () => ({ mode: "workspace", files: fixturePlan.reviewedFiles.map((path) => ({ path, status: "modified", additions: 1, deletions: 1 })), ruleGroups: [] }),
          diffs: async () => [],
          plan: async () => ({ version: 1, hypotheses: fixturePlan.hypotheses } as unknown as AnalysisPlan),
          sandbox: async (mode) => (mode === "vulnerable" ? fixturePlan.vulnerableResults : fixturePlan.patchedResults) as unknown as ExecutionResult[],
        };
        return pipeline;
      },
    });
    try {
      for (const model of ["first", "second"]) {
        const save = await app.inject({ method: "POST", url: "/api/setup", headers, payload: { ...settings, model } });
        assert.equal(save.statusCode, 200);
        const run = await app.inject({ method: "POST", url: "/api/runs", payload: { source: "workspace" } });
        assert.equal(run.statusCode, 201);
        assert.equal(run.json().model, model);
      }
      assert.deepEqual(seen, ["first:localhost/trustgate-target:latest", "second:localhost/trustgate-target:latest"]);
    } finally { await app.close(); }
  });
});

test("setup rejects cross-site writes, remote hosts, remote clients and absent POST origins", async () => {
  await withStore(async (setupStore) => {
    const app = buildServer({ mode: "workspace", setupStore });
    try {
      const probes = [
        { headers: { host: "127.0.0.1:8787", origin: "http://evil.example" } },
        { headers: { host: "evil.example", origin: "http://localhost:5173" } },
        { headers: { host: "127.0.0.1:8787" } },
        { headers, remoteAddress: "203.0.113.10" },
        { headers: { host: "127.0.0.1:8787", origin: "http://localhost:5173.evil.example" } },
      ];
      for (const probe of probes) {
        const result = await app.inject({ method: "POST", url: "/api/setup", payload: settings, ...probe });
        assert.equal(result.statusCode, 403, JSON.stringify(probe));
        assert.deepEqual(result.json(), { error: "invalid request" });
        assert.equal(result.headers["cache-control"], "no-store");
      }
      for (const probe of [
        { headers: { host: "evil.example" } },
        { headers: { host: "127.0.0.1:8787", origin: "https://evil.example" } },
        { headers, remoteAddress: "198.51.100.5" },
      ]) {
        const result = await app.inject({ method: "GET", url: "/api/setup", ...probe });
        assert.equal(result.statusCode, 403, JSON.stringify(probe));
      }
      assert.equal(await setupStore.read(), null);
      const vite = await app.inject({ method: "POST", url: "/api/setup", headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:5173" }, payload: settings });
      assert.equal(vite.statusCode, 200);
      const direct = await app.inject({ method: "POST", url: "/api/setup", headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }, payload: settings });
      assert.equal(direct.statusCode, 200);
    } finally { await app.close(); }
  });
});

test("encoded setup routes enforce the origin guard before writes or provider calls", async () => {
  await withStore(async (setupStore) => {
    let providerCalls = 0;
    const provider = createServer((_request, response) => {
      providerCalls++;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "pong" }, finish_reason: "stop" }] }));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    assert.ok(address && typeof address !== "string");
    const savedSettings = { ...settings, baseUrl: `http://127.0.0.1:${address.port}/v1` };
    await setupStore.save(savedSettings);
    const records: Array<{ event: string; route?: string }> = [];
    const app = buildServer({ mode: "workspace", setupStore, log: (record) => records.push(record) });
    try {
      const evil = { host: "127.0.0.1:8787", origin: "https://evil.example" };
      for (const url of ["/api/%73etup", "/api/%73etup?ignored=1"]) {
        const result = await app.inject({ method: "GET", url, headers: evil });
        assert.equal(result.statusCode, 403, url);
        assert.deepEqual(result.json(), { error: "invalid request" });
        assert.equal(result.headers["cache-control"], "no-store");
      }
      for (const requestHeaders of [evil, { host: "127.0.0.1:8787" }]) {
        const write = await app.inject({ method: "POST", url: "/api/%73etup", headers: requestHeaders, payload: { ...savedSettings, model: "injected" } });
        assert.equal(write.statusCode, 403, JSON.stringify(requestHeaders));
        assert.deepEqual(write.json(), { error: "invalid request" });
        assert.equal(write.headers["cache-control"], "no-store");
        const ping = await app.inject({ method: "POST", url: "/api/%73etup/test", headers: requestHeaders, payload: {} });
        assert.equal(ping.statusCode, 403, JSON.stringify(requestHeaders));
        assert.deepEqual(ping.json(), { error: "invalid request" });
        assert.equal(ping.headers["cache-control"], "no-store");
      }
      assert.deepEqual(await setupStore.read(), savedSettings);
      assert.equal(providerCalls, 0);
      assert.deepEqual(records.filter((record) => record.event === "request").map((record) => record.route), [
        "/api/setup", "/api/setup", "/api/setup", "/api/setup/test", "/api/setup", "/api/setup/test",
      ]);
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test("run routes reject hostile host, origin and remote peer before execution or disclosure", async () => {
  let pipelineCalls = 0;
  const app = buildServer({
    mode: "workspace",
    rootDir: process.cwd(),
    createWorkspacePipeline: () => { pipelineCalls++; throw new Error("run pipeline must not start"); },
  });
  try {
    const fixture = await app.inject({ method: "POST", url: "/api/runs", payload: { source: "fixture" } });
    assert.equal(fixture.statusCode, 201, "CLI without Origin must work");
    const runUrl = `/api/runs/${fixture.json().runId as string}`;
    const cliRead = await app.inject({ method: "GET", url: runUrl });
    assert.equal(cliRead.statusCode, 200);
    const vite = await app.inject({ method: "POST", url: "/api/runs", headers, payload: { source: "fixture" } });
    assert.equal(vite.statusCode, 201, "existing Vite origin must work");
    const direct = await app.inject({ method: "GET", url: runUrl, headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" } });
    assert.equal(direct.statusCode, 200, "direct local origin must work");

    const probes = [
      { headers: { host: "evil.example", origin: "http://localhost:5173" } },
      { headers: { host: "127.0.0.1:8787", origin: "https://evil.example" } },
      { headers: { host: "127.0.0.1:8787" }, remoteAddress: "203.0.113.10" },
    ];
    for (const probe of probes) {
      const write = await app.inject({ method: "POST", url: "/api/runs", payload: { source: "workspace" }, ...probe });
      assert.equal(write.statusCode, 403, JSON.stringify(probe));
      assert.deepEqual(write.json(), { error: "invalid request" });
      assert.equal(write.headers["cache-control"], "no-store");
      const read = await app.inject({ method: "GET", url: runUrl, ...probe });
      assert.equal(read.statusCode, 403, JSON.stringify(probe));
      assert.deepEqual(read.json(), { error: "invalid request" });
      assert.equal(read.headers["cache-control"], "no-store");
    }
    assert.equal(pipelineCalls, 0);
    const health = await app.inject({ method: "GET", url: "/health", ...probes[0] });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { ok: true });
  } finally { await app.close(); }
});

test("setup rejects unknown fields and never returns or logs a credential value", async () => {
  await withStore(async (setupStore) => {
    const records: unknown[] = [];
    const variable = "TRUSTGATE_SETUP_TEST_SECRET_VAR";
    const prior = process.env[variable];
    const value = ["sk-", "A".repeat(28)].join("");
    process.env[variable] = value;
    const app = buildServer({ mode: "workspace", setupStore, log: (record) => records.push(record) });
    try {
      const invalid = await app.inject({ method: "POST", url: "/api/setup", headers, payload: { ...settings, apiKeyEnv: variable, apiKey: value } });
      assert.equal(invalid.statusCode, 400);
      assert.deepEqual(invalid.json(), { error: "invalid request" });
      assert.equal(await setupStore.read(), null);
      const saved = await app.inject({ method: "POST", url: "/api/setup", headers, payload: { ...settings, apiKeyEnv: variable } });
      assert.equal(saved.statusCode, 200);
      assert.equal(saved.json().settings.keyAvailable, true);
      assert.equal((await app.inject({ method: "GET", url: "/api/setup", headers })).json().settings.keyAvailable, true);
      assert.ok(!saved.body.includes(value));
      assert.ok(!JSON.stringify(records).includes(value));
      delete process.env[variable];
      const missing = await app.inject({ method: "GET", url: "/api/setup", headers });
      assert.equal(missing.json().settings.keyAvailable, false);
      assert.equal((await app.inject({ method: "POST", url: "/api/setup/test", headers, payload: {} })).statusCode, 503);
      assert.ok(!JSON.stringify(records).includes(value));
    } finally {
      if (prior === undefined) delete process.env[variable]; else process.env[variable] = prior;
      await app.close();
    }
  });
});

test("invalid XDG directory fails closed without crashing the server or disclosing paths", async () => {
  const prior = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "relative-config-dir";
  try {
    const app = buildServer({ mode: "workspace" });
    try {
      const result = await app.inject({ method: "GET", url: "/api/setup", headers });
      assert.equal(result.statusCode, 503);
      assert.deepEqual(result.json(), { error: "setup unavailable" });
      assert.ok(!result.body.includes("relative-config-dir"));
    } finally { await app.close(); }
  } finally {
    if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prior;
  }
});

test("environment config is a fallback only when no saved settings exist", async () => {
  await withStore(async (setupStore) => {
    const names = ["TRUSTGATE_LLM_BASE_URL", "TRUSTGATE_LLM_MODEL", "TRUSTGATE_LLM_API_KEY_ENV", "TRUSTGATE_LLM_KIND", "TRUSTGATE_SANDBOX_IMAGE"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.TRUSTGATE_LLM_BASE_URL = "http://127.0.0.1:9999/v1";
    process.env.TRUSTGATE_LLM_MODEL = "fallback";
    process.env.TRUSTGATE_LLM_API_KEY_ENV = "";
    process.env.TRUSTGATE_LLM_KIND = "openai-compatible";
    process.env.TRUSTGATE_SANDBOX_IMAGE = settings.sandboxImage;
    const app = buildServer({ mode: "workspace", setupStore });
    try {
      const fallback = await app.inject({ method: "GET", url: "/api/setup", headers });
      assert.equal(fallback.statusCode, 200);
      assert.deepEqual(fallback.json(), { mode: "workspace", configured: true, settings: { ...settings, model: "fallback", keyAvailable: false } });
      await setupStore.save(settings);
      const saved = await app.inject({ method: "GET", url: "/api/setup", headers });
      assert.equal(saved.json().settings.model, settings.model);
    } finally {
      await app.close();
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});

test("connection test uses the env fallback and prefers stored settings when present", async () => {
  await withStore(async (setupStore) => {
    const requests: Array<{ url: string | undefined; model: unknown }> = [];
    const provider = createServer((request, response) => {
      let body = "";
      request.on("data", (data: Buffer) => { body += data.toString(); });
      request.on("end", () => {
        requests.push({ url: request.url, model: (JSON.parse(body) as { model?: unknown }).model });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: "pong" }, finish_reason: "stop" }] }));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    assert.ok(address && typeof address !== "string");
    const names = ["TRUSTGATE_LLM_BASE_URL", "TRUSTGATE_LLM_MODEL", "TRUSTGATE_LLM_API_KEY_ENV", "TRUSTGATE_LLM_KIND", "TRUSTGATE_SANDBOX_IMAGE"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const envSettings = { ...settings, baseUrl: `http://127.0.0.1:${address.port}/env/v1`, model: "fallback" };
    const storedSettings = { ...settings, baseUrl: `http://127.0.0.1:${address.port}/saved/v1`, model: "stored" };
    process.env.TRUSTGATE_LLM_BASE_URL = envSettings.baseUrl;
    process.env.TRUSTGATE_LLM_MODEL = envSettings.model;
    process.env.TRUSTGATE_LLM_API_KEY_ENV = "";
    process.env.TRUSTGATE_LLM_KIND = envSettings.kind;
    process.env.TRUSTGATE_SANDBOX_IMAGE = envSettings.sandboxImage;
    const app = buildServer({ mode: "workspace", setupStore });
    try {
      const fallback = await app.inject({ method: "GET", url: "/api/setup", headers });
      assert.equal(fallback.statusCode, 200);
      assert.deepEqual(fallback.json().settings, { ...envSettings, keyAvailable: false });
      const envTest = await app.inject({ method: "POST", url: "/api/setup/test", headers, payload: {} });
      assert.equal(envTest.statusCode, 200);
      assert.deepEqual(envTest.json(), { ok: true });
      assert.deepEqual(requests, [{ url: "/env/v1/chat/completions", model: "fallback" }]);
      await setupStore.save(storedSettings);
      const stored = await app.inject({ method: "GET", url: "/api/setup", headers });
      assert.deepEqual(stored.json().settings, { ...storedSettings, keyAvailable: false });
      const storedTest = await app.inject({ method: "POST", url: "/api/setup/test", headers, payload: {} });
      assert.equal(storedTest.statusCode, 200);
      assert.deepEqual(storedTest.json(), { ok: true });
      assert.deepEqual(requests, [
        { url: "/env/v1/chat/completions", model: "fallback" },
        { url: "/saved/v1/chat/completions", model: "stored" },
      ]);
    } finally {
      await app.close();
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test("connection test returns fixed failures for missing or unreachable settings", async () => {
  await withStore(async (setupStore) => {
    const app = buildServer({ mode: "workspace", setupStore });
    try {
      const missing = await app.inject({ method: "POST", url: "/api/setup/test", headers, payload: {} });
      assert.equal(missing.statusCode, 503);
      assert.deepEqual(missing.json(), { error: "connection test failed" });
      const invalid = await app.inject({ method: "POST", url: "/api/setup/test", headers, payload: { baseUrl: "http://localhost:1234" } });
      assert.equal(invalid.statusCode, 400);
      await setupStore.save(settings);
      const failure = await app.inject({ method: "POST", url: "/api/setup/test", headers, payload: {} });
      assert.equal(failure.statusCode, 503);
      assert.deepEqual(failure.json(), { error: "connection test failed" });
      assert.equal(failure.headers["cache-control"], "no-store");
    } finally { await app.close(); }
  });
});
