import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSetupStore, parseSetupSettings } from "../src/setup-store.js";
import { buildServer } from "../src/server.js";

const settings = {
  kind: "openai-compatible" as const,
  baseUrl: "http://127.0.0.1:9999/v1",
  model: "local-model",
  apiKeyEnv: "LOCAL_LLM_KEY",
  sandboxImage: "localhost/trustgate-target:latest",
};

const withStore = async (run: (path: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "trustgate-setup-store-"));
  try {
    await run(join(root, "trustgate", "config.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("settings save and reload without secrets, in private directory and file", async () => {
  await withStore(async (path) => {
    const store = createSetupStore({ configPath: path });
    assert.equal(await store.read(), null);
    assert.deepEqual(await store.save(settings), settings);
    assert.deepEqual(await createSetupStore({ configPath: path }).read(), settings);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), settings);
    assert.equal((await stat(join(path, ".."))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test("credential-shaped apiKeyEnv literals are refused before save and never returned by setup GET", async () => {
  await withStore(async (path) => {
    const store = createSetupStore({ configPath: path });
    const literal = `ghp_${"A".repeat(20)}`; // Synthetic shape only; never log it.
    for (const credentialLike of [literal, `gho_${"B".repeat(20)}`, `github_pat_${"C".repeat(20)}`, `AKIA${"D".repeat(16)}`, `sk_live_${"E".repeat(24)}`]) {
      assert.throws(() => parseSetupSettings({ ...settings, apiKeyEnv: credentialLike }), /invalid setup configuration/);
    }
    await assert.rejects(store.save({ ...settings, apiKeyEnv: literal }), /invalid setup configuration/);
    assert.equal(await store.read(), null);
    const app = buildServer({ mode: "fixture", setupStore: store });
    try {
      const headers = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" };
      const rejected = await app.inject({ method: "POST", url: "/api/setup", headers, payload: { ...settings, apiKeyEnv: literal } });
      assert.equal(rejected.statusCode, 400);
      assert.ok(!rejected.body.includes(literal));
      const read = await app.inject({ method: "GET", url: "/api/setup", headers });
      assert.deepEqual(read.json(), { mode: "fixture", configured: false, settings: null });
      assert.ok(!read.body.includes(literal));
      assert.equal(await store.read(), null);
      // A previously written unsafe config must also fail closed on GET, not echo the value.
      await mkdir(join(path, ".."), { mode: 0o700 });
      await writeFile(path, JSON.stringify({ ...settings, apiKeyEnv: literal }), { mode: 0o600 });
      await assert.rejects(store.read(), /invalid setup configuration/);
      const previouslySaved = await app.inject({ method: "GET", url: "/api/setup", headers });
      assert.equal(previouslySaved.statusCode, 503);
      assert.deepEqual(previouslySaved.json(), { error: "setup unavailable" });
      assert.ok(!previouslySaved.body.includes(literal));
    } finally { await app.close(); }
    const nearMiss = `ghp_${"A".repeat(19)}`;
    assert.equal(parseSetupSettings({ ...settings, apiKeyEnv: nearMiss }).apiKeyEnv, nearMiss);
    assert.equal(parseSetupSettings({
      ...settings, baseUrl: "https://llm.example/v1", model: "model-sk-test",
      apiKeyEnv: "OPENAI_API_KEY", sandboxImage: "localhost/trustgate-target:latest",
    }).apiKeyEnv, "OPENAI_API_KEY");
    assert.equal(parseSetupSettings(settings).apiKeyEnv, "LOCAL_LLM_KEY");
  });
});

test("invalid settings reject unsafe URLs, variable names, image refs, unknown fields and huge values", () => {
  for (const change of [
    { baseUrl: "https://user:password@example.com/v1" },
    { baseUrl: "https://example.com/v1?key=abc" },
    { baseUrl: "https://example.com/v1#key" },
    { baseUrl: "file:///etc/passwd" },
    { baseUrl: "https://example.com:443/v1" },
    { baseUrl: "https://example.com/v1" + "x".repeat(2050) },
    { apiKeyEnv: "KEY-NAME" },
    { apiKeyEnv: "A".repeat(129) },
    { sandboxImage: "docker://example/image" },
    { sandboxImage: "-evil:latest" },
    { kind: "openai-codex-oauth" },
    { model: "" },
    { model: "model\nsecret" },
    { apiKey: "secret" },
  ]) {
    assert.throws(() => parseSetupSettings({ ...settings, ...change }), /invalid setup configuration/);
  }
  assert.equal(parseSetupSettings({ ...settings, apiKeyEnv: "" }).apiKeyEnv, "");
  assert.equal(parseSetupSettings({ ...settings, baseUrl: "http://100.83.9.79:20128/v1", apiKeyEnv: "" }).baseUrl, "http://100.83.9.79:20128/v1");
  assert.equal(parseSetupSettings({ ...settings, baseUrl: "https://example.com/v1" }).baseUrl, "https://example.com/v1");
});

test("Codex OAuth requires explicit selection and empty API fields, then persists without credentials", async () => {
  const oauth = { ...settings, kind: "openai-codex-oauth", baseUrl: "", apiKeyEnv: "", model: "gpt-5-codex" };
  await withStore(async (path) => {
    const store = createSetupStore({ configPath: path });
    assert.deepEqual(await store.save(oauth), oauth);
    assert.deepEqual(await store.read(), oauth);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), oauth);
    for (const change of [{ baseUrl: "https://api.openai.com/v1" }, { apiKeyEnv: "OPENAI_API_KEY" }, { authFilePath: "/home/user/auth.json" }]) {
      assert.throws(() => parseSetupSettings({ ...oauth, ...change }), /invalid setup configuration/);
    }
  });
});

test("synthetic Google-shaped credential in env name is refused on save and on read", async () => {
  await withStore(async (path) => {
    const store = createSetupStore({ configPath: path });
    const unsafe = { ...settings, apiKeyEnv: `AIza${"A".repeat(35)}` };
    await assert.rejects(store.save(unsafe), /invalid setup configuration/);
    assert.equal(await store.read(), null);
    await mkdir(join(path, ".."), { mode: 0o700 });
    await writeFile(path, JSON.stringify(unsafe), { mode: 0o600 });
    await assert.rejects(store.read(), /invalid setup configuration/);
    const app = buildServer({ mode: "fixture", setupStore: store });
    try {
      const result = await app.inject({ method: "GET", url: "/api/setup", headers: { host: "127.0.0.1:8787" } });
      assert.equal(result.statusCode, 503);
      assert.deepEqual(result.json(), { error: "setup unavailable" });
      assert.equal(result.body.includes(unsafe.apiKeyEnv), false);
    } finally { await app.close(); }
  });
});

test("synthetic provider key in URL path is refused on save and on read without reflection", async () => {
  await withStore(async (path) => {
    const store = createSetupStore({ configPath: path });
    const token = `sk-proj-${"Z".repeat(32)}`;
    const unsafe = { ...settings, baseUrl: `https://llm.example/v1/${token}` };
    await assert.rejects(store.save(unsafe), /invalid setup configuration/);
    assert.equal(await store.read(), null);
    await mkdir(join(path, ".."), { mode: 0o700 });
    await writeFile(path, JSON.stringify(unsafe), { mode: 0o600 });
    await assert.rejects(store.read(), /invalid setup configuration/);
    const app = buildServer({ mode: "fixture", setupStore: store });
    try {
      const result = await app.inject({ method: "GET", url: "/api/setup", headers: { host: "127.0.0.1:8787" } });
      assert.equal(result.statusCode, 503);
      assert.deepEqual(result.json(), { error: "setup unavailable" });
      assert.equal(result.body.includes(token), false);
    } finally { await app.close(); }
  });
});

test("credential literals in every reflected string field fail save and old-config read", async () => {
  await withStore(async (path) => {
    const store = createSetupStore({ configPath: path });
    const git = `gho_${"b".repeat(36)}`;
    const google = `AIza${"c".repeat(35)}`;
    const provider = `sk-proj-${"a".repeat(32)}`;
    const cases = [
      { ...settings, baseUrl: `https://llm.example/v1/${git}` },
      { ...settings, model: `model-${google}` },
      { ...settings, model: `model_${git}` },
      { ...settings, sandboxImage: `localhost/${provider}:latest` },
    ];
    for (const unsafe of cases) {
      await assert.rejects(store.save(unsafe), /invalid setup configuration/);
      await mkdir(join(path, ".."), { mode: 0o700, recursive: true });
      await writeFile(path, JSON.stringify(unsafe), { mode: 0o600 });
      await assert.rejects(store.read(), /invalid setup configuration/);
      await rm(path);
    }
    assert.equal(await store.read(), null);
  });
});

test("remote HTTPS accepts empty legacy env name for credential-store flow", async () => {
  await withStore(async (path) => {
    const store = createSetupStore({ configPath: path });
    const remote = { ...settings, baseUrl: "https://llm.example/v1", apiKeyEnv: "" };
    assert.deepEqual(await store.save(remote), remote);
    assert.deepEqual(await store.read(), remote);
  });
});

test("symlink components and existing config symlinks cannot be read or overwritten", async () => {
  await withStore(async (path) => {
    const outside = join(path, "..", "..", "outside.json");
    await writeFile(outside, "private", { mode: 0o600 });
    await mkdir(join(path, ".."), { mode: 0o700 });
    await symlink(outside, path);
    const store = createSetupStore({ configPath: path });
    await assert.rejects(store.read());
    await assert.rejects(store.save(settings));
    assert.equal(await readFile(outside, "utf8"), "private");
    await rm(path);
    await rm(join(path, ".."), { recursive: true });
    await symlink(join(path, "..", ".."), join(path, ".."));
    await assert.rejects(store.read());
    await assert.rejects(store.save(settings));
  });
});

test("an existing world-readable config directory cannot expose settings", async () => {
  await withStore(async (path) => {
    await mkdir(join(path, ".."), { mode: 0o755 });
    await writeFile(path, JSON.stringify(settings), { mode: 0o600 });
    const store = createSetupStore({ configPath: path });
    await assert.rejects(store.read());
    await assert.rejects(store.save(settings));
  });
});

test("hard-linked existing config cannot be read or overwritten", async () => {
  await withStore(async (path) => {
    await mkdir(join(path, ".."), { mode: 0o700 });
    const external = join(path, "..", "..", "external.json");
    await writeFile(external, JSON.stringify(settings), { mode: 0o600 });
    await link(external, path);
    const store = createSetupStore({ configPath: path });
    await assert.rejects(store.read());
    await assert.rejects(store.save(settings));
    assert.deepEqual(JSON.parse(await readFile(external, "utf8")), settings);
  });
});

test("malformed, oversized, or permissive existing configuration fails closed", async () => {
  await withStore(async (path) => {
    await mkdir(join(path, ".."), { mode: 0o700 });
    const store = createSetupStore({ configPath: path });
    for (const content of ["{", JSON.stringify({ ...settings, apiKey: "secret" }), "x".repeat(4097)]) {
      await writeFile(path, content, { mode: 0o600 });
      await assert.rejects(store.read());
    }
    await rm(path);
    await writeFile(path, JSON.stringify(settings), { mode: 0o644 });
    await assert.rejects(store.read());
    await assert.rejects(store.save(settings));
  });
});
