import assert from "node:assert/strict";
import test from "node:test";
import { buildServer } from "../src/server.js";
import { ExistingOAuthLoginError } from "../src/oauth-login.js";


const headers = { host: "127.0.0.1:8787", origin: "http://localhost:5173" };
const url = "https://auth.openai.com/oauth/authorize?state=opaque";

test("existing local auth is reported without opening or overwriting credentials", async () => {
  let called = 0;
  const app = buildServer({ oauthLogin: async () => { called++; throw new ExistingOAuthLoginError(); } });
  try {
    const result = await app.inject({ method: "POST", url: "/api/setup/oauth/start", headers, payload: {} });
    assert.equal(result.statusCode, 409);
    assert.deepEqual(result.json(), { state: "existing" });
    assert.equal(called, 1);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/setup/oauth/status", headers })).json(), { state: "existing" });
  } finally { await app.close(); }
});

test("OAuth start returns only allowlisted URL and exposes sanitized state", async () => {
  let finish!: () => void;
  const app = buildServer({ oauthLogin: async ({ onMessage, signal }) => {
    onMessage(`OpenAI OAuth login URL: ${url}`);
    await new Promise<void>((resolve) => { finish = resolve; signal.addEventListener("abort", () => resolve()); });
  } });
  try {
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/setup/oauth/status", headers })).json(), { state: "idle" });
    const started = await app.inject({ method: "POST", url: "/api/setup/oauth/start", headers, payload: {} });
    assert.deepEqual(started.json(), { url });
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/setup/oauth/status", headers })).json(), { state: "pending" });
    assert.equal((await app.inject({ method: "POST", url: "/api/setup/oauth/start", headers, payload: {} })).statusCode, 409);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/setup/oauth/status", headers })).json(), { state: "ready" });
  } finally { await app.close(); }
});

test("OAuth rejects cross-origin requests and unsafe provider URLs", async () => {
  const app = buildServer({ oauthLogin: async ({ onMessage }) => { onMessage("OpenAI OAuth login URL: https://evil.example/steal"); } });
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/setup/oauth/start", headers: { host: "127.0.0.1:8787", origin: "https://evil.example" }, payload: {} })).statusCode, 403);
    const failed = await app.inject({ method: "POST", url: "/api/setup/oauth/start", headers, payload: {} });
    assert.equal(failed.statusCode, 503);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/setup/oauth/status", headers })).json(), { state: "error" });
  } finally { await app.close(); }
});

test("OAuth cancellation aborts pending login and clears state", async () => {
  let aborted = false;
  const app = buildServer({ oauthLogin: async ({ onMessage, signal }) => {
    onMessage(`OpenAI OAuth login URL: ${url}`);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }));
  } });
  try {
    await app.inject({ method: "POST", url: "/api/setup/oauth/start", headers, payload: {} });
    assert.deepEqual((await app.inject({ method: "POST", url: "/api/setup/oauth/cancel", headers, payload: {} })).json(), { state: "idle" });
    assert.equal(aborted, true);
  } finally { await app.close(); }
});
