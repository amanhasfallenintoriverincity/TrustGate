import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildServer } from "../src/server.js";

const INDEX = '<!doctype html><script type="module" src="/assets/index-A1b2C3d4.js"></script><link rel="stylesheet" href="/assets/index-E5f6G7h8.css">';
const JS = "console.log('dashboard');";
const CSS = "body { color: red; }";

const withDashboard = async (run: (dist: string) => Promise<void>): Promise<void> => {
  const dist = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "trustgate-dashboard-"));
  await mkdir(join(dist, "assets"));
  await writeFile(join(dist, "index.html"), INDEX);
  await writeFile(join(dist, "assets/index-A1b2C3d4.js"), JS);
  await writeFile(join(dist, "assets/index-E5f6G7h8.css"), CSS);
  try { await run(dist); }
  finally { await rm(dist, { recursive: true, force: true }); }
};

test("dashboard rejects hostile hosts, peers, origins and non-manifest paths without leaking files", async () => {
  await withDashboard(async (dist) => {
    const privateFile = join(dist, "private.txt");
    await writeFile(privateFile, "NOT_PUBLIC_SECRET");
    await writeFile(join(dist, "assets/index-U8u8U8u8.js"), "NOT_PUBLIC_SECRET");
    await symlink(privateFile, join(dist, "assets/index-Z9z9Z9z9.js"));
    const app = buildServer({ mode: "fixture", dashboardDistDir: dist });
    try {
      for (const url of ["/private.txt", "/assets/index-U8u8U8u8.js", "/assets/index-Z9z9Z9z9.js", "/assets/%2e%2e%2fprivate.txt", "/assets/index-A1b2C3d4.js/../../private.txt", "/.env"]) {
        const response = await app.inject({ method: "GET", url });
        assert.notEqual(response.statusCode, 200, url);
        assert.ok(!response.body.includes("NOT_PUBLIC_SECRET"));
      }
      for (const probe of [
        { headers: { host: "evil.example" } },
        { headers: { host: "127.0.0.1:8787", origin: "http://evil.example" } },
        { headers: { host: "127.0.0.1:8787" }, remoteAddress: "198.51.100.2" },
      ]) {
        for (const url of ["/", "/assets/index-A1b2C3d4.js"]) {
          const response = await app.inject({ method: "GET", url, ...probe });
          assert.equal(response.statusCode, 403, url);
          assert.deepEqual(response.json(), { error: "invalid request" });
        }
      }
    } finally { await app.close(); }
  });
});

test("missing prebuilt assets fail closed without serving files from arbitrary paths", async () => {
  await withDashboard(async (dist) => {
    await rm(join(dist, "assets/index-A1b2C3d4.js"));
    const app = buildServer({ mode: "fixture", dashboardDistDir: dist });
    try {
      for (const url of ["/", "/assets/index-E5f6G7h8.css"]) {
        const response = await app.inject({ method: "GET", url });
        assert.equal(response.statusCode, 503);
        assert.deepEqual(response.json(), { error: "dashboard unavailable" });
        assert.ok(!response.body.includes(dist));
      }
      assert.deepEqual((await app.inject({ method: "GET", url: "/health" })).json(), { ok: true });
    } finally { await app.close(); }
  });
});

test("unreferenced hashed-looking files are not exposed", async () => {
  await withDashboard(async (dist) => {
    await writeFile(join(dist, "assets/index-U8u8U8u8.js"), "NOT_PUBLIC_SECRET");
    const app = buildServer({ mode: "fixture", dashboardDistDir: dist });
    try {
      assert.equal((await app.inject({ method: "GET", url: "/" })).statusCode, 200);
      const response = await app.inject({ method: "GET", url: "/assets/index-U8u8U8u8.js" });
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: "not found" });
      assert.ok(!response.body.includes("NOT_PUBLIC_SECRET"));
    } finally { await app.close(); }
  });
});

test("prebuilt dashboard index and hashed assets are served alongside the existing API", async () => {
  await withDashboard(async (dist) => {
    const app = buildServer({ mode: "fixture", dashboardDistDir: dist });
    try {
      const index = await app.inject({ method: "GET", url: "/" });
      assert.equal(index.statusCode, 200);
      assert.equal(index.body, INDEX);
      assert.match(String(index.headers["content-type"]), /^text\/html/);
      assert.equal(index.headers["x-content-type-options"], "nosniff");
      const explicitIndex = await app.inject({ method: "GET", url: "/index.html" });
      assert.equal(explicitIndex.statusCode, 200);
      assert.equal(explicitIndex.body, INDEX);
      for (const [url, content, mime] of [
        ["/assets/index-A1b2C3d4.js", JS, "application/javascript"],
        ["/assets/index-E5f6G7h8.css", CSS, "text/css"],
      ] as const) {
        const response = await app.inject({ method: "GET", url });
        assert.equal(response.statusCode, 200);
        assert.equal(response.body, content);
        assert.match(String(response.headers["content-type"]), new RegExp(`^${mime}`));
        assert.equal(response.headers["x-content-type-options"], "nosniff");
      }
      assert.deepEqual((await app.inject({ method: "GET", url: "/health" })).json(), { ok: true });
      assert.equal((await app.inject({ method: "POST", url: "/api/runs", payload: { source: "fixture" } })).statusCode, 201);
      assert.deepEqual((await app.inject({ method: "GET", url: "/api/unknown" })).json(), { error: "not found" });
    } finally { await app.close(); }
  });
});

test("CSS-referenced hashed font is served, but unrelated fonts stay private and missing fonts fail closed", async () => {
  await withDashboard(async (dist) => {
    const font = "geist-latin-A1b2C3d4.woff2";
    const unrelated = "private-Z9z9Z9z9.woff2";
    await writeFile(join(dist, "assets/index-E5f6G7h8.css"),
      `@font-face { font-family: Geist; src: url(/assets/${font}) format("woff2"); }`);
    await writeFile(join(dist, `assets/${font}`), "FONT_DATA");
    await writeFile(join(dist, `assets/${unrelated}`), "NOT_PUBLIC_SECRET");

    const app = buildServer({ mode: "fixture", dashboardDistDir: dist });
    try {
      const response = await app.inject({ method: "GET", url: `/assets/${font}` });
      assert.equal(response.statusCode, 200);
      assert.equal(response.rawPayload.toString(), "FONT_DATA");
      assert.match(String(response.headers["content-type"]), /^font\/woff2/);
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      const denied = await app.inject({ method: "GET", url: `/assets/${unrelated}` });
      assert.equal(denied.statusCode, 404);
      assert.ok(!denied.body.includes("NOT_PUBLIC_SECRET"));
    } finally { await app.close(); }

    await rm(join(dist, `assets/${font}`));
    const broken = buildServer({ mode: "fixture", dashboardDistDir: dist });
    try {
      assert.equal((await broken.inject({ method: "GET", url: "/" })).statusCode, 503);
    } finally { await broken.close(); }
  });
});
