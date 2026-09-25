import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildServer } from "../src/server.js";

const headers = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" };
const agentDir = { codex: ".agents", claude: ".claude", cursor: ".cursor", hermes: ".hermes" } as const;

const withProject = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "trustgate-skill-api-"));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
};

test("workspace installs the shared TrustGate CLI skill for each enumerated agent into only the pinned root", async () => {
  await withProject(async (root) => {
    const app = buildServer({ mode: "workspace", rootDir: root });
    try {
      for (const [agent, dir] of Object.entries(agentDir)) {
        const response = await app.inject({ method: "POST", url: "/api/skills/install", headers, payload: { agent } });
        assert.equal(response.statusCode, 201, agent);
        assert.deepEqual(response.json(), { agent, installed: true });
        assert.equal(response.headers["cache-control"], "no-store");
        const file = await readFile(join(root, dir, "skills", "trustgate", "SKILL.md"), "utf8");
        assert.match(file, /TrustGate/);
        assert.ok(!file.includes("{{TRUSTGATE_CLI}}"));
      }
    } finally { await app.close(); }
  });
});

test("fixture mode and an unpinned workspace refuse installation without writing", async () => {
  await withProject(async (root) => {
    for (const app of [buildServer({ mode: "fixture", rootDir: root }), buildServer({ mode: "workspace" })]) {
      try {
        const response = await app.inject({ method: "POST", url: "/api/skills/install", headers, payload: { agent: "codex" } });
        assert.equal(response.statusCode, 403);
        assert.deepEqual(response.json(), { error: "skill install unavailable" });
      } finally { await app.close(); }
    }
    await assert.rejects(stat(join(root, ".agents")), { code: "ENOENT" });
  });
});

test("a relative root is not operator-pinned for installation", async () => {
  const app = buildServer({ mode: "workspace", rootDir: "." });
  try {
    const response = await app.inject({ method: "POST", url: "/api/skills/install", headers, payload: { agent: "codex" } });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), { error: "skill install unavailable" });
  } finally { await app.close(); }
});

test("an existing skill is a conflict and is never overwritten", async () => {
  await withProject(async (root) => {
    const app = buildServer({ mode: "workspace", rootDir: root });
    try {
      const first = await app.inject({ method: "POST", url: "/api/skills/install", headers, payload: { agent: "codex" } });
      assert.equal(first.statusCode, 201);
      const path = join(root, ".agents", "skills", "trustgate", "SKILL.md");
      await writeFile(path, "custom skill content");
      const again = await app.inject({ method: "POST", url: "/api/skills/install", headers, payload: { agent: "codex" } });
      assert.equal(again.statusCode, 409);
      assert.deepEqual(again.json(), { error: "skill already installed" });
      assert.equal(await readFile(path, "utf8"), "custom skill content");
    } finally { await app.close(); }
  });
});

test("an existing directory at the skill target is reported as a conflict", async () => {
  await withProject(async (root) => {
    const target = join(root, ".cursor", "skills", "trustgate", "SKILL.md");
    await mkdir(target, { recursive: true });
    const app = buildServer({ mode: "workspace", rootDir: root });
    try {
      const response = await app.inject({ method: "POST", url: "/api/skills/install", headers, payload: { agent: "cursor" } });
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { error: "skill already installed" });
      assert.ok((await stat(target)).isDirectory());
    } finally { await app.close(); }
  });
});

test("an existing symlinked skill target is a conflict without following or overwriting it", async () => {
  await withProject(async (root) => {
    const outside = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "trustgate-existing-target-"));
    const marker = join(outside, "marker.txt");
    await writeFile(marker, "KEEP");
    await mkdir(join(root, ".cursor", "skills", "trustgate"), { recursive: true });
    await symlink(marker, join(root, ".cursor", "skills", "trustgate", "SKILL.md"));
    const app = buildServer({ mode: "workspace", rootDir: root });
    try {
      const response = await app.inject({ method: "POST", url: "/api/skills/install", headers, payload: { agent: "cursor" } });
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { error: "skill already installed" });
      assert.equal(await readFile(marker, "utf8"), "KEEP");
    } finally { await app.close(); await rm(outside, { recursive: true, force: true }); }
  });
});

test("malformed or browser-provided project arguments cannot select an installation root", async () => {
  await withProject(async (root) => {
    const outside = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "trustgate-no-install-"));
    const app = buildServer({ mode: "workspace", rootDir: root });
    try {
      for (const payload of [
        {}, { agent: "cursor", project: outside }, { agent: "cursor", root: outside },
        { agent: "../../outside" }, { agent: "CODEX" }, { agent: null }, { agent: ["codex"] },
      ]) {
        const response = await app.inject({ method: "POST", url: "/api/skills/install", headers, payload });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
        assert.deepEqual(response.json(), { error: "invalid request" });
        assert.ok(!response.body.includes(outside));
      }
      await assert.rejects(stat(join(root, ".cursor")), { code: "ENOENT" });
      await assert.rejects(stat(join(outside, ".cursor")), { code: "ENOENT" });
    } finally { await app.close(); await rm(outside, { recursive: true, force: true }); }
  });
});

test("skill installation enforces local Host/Origin/peer guard on encoded aliases", async () => {
  await withProject(async (root) => {
    const app = buildServer({ mode: "workspace", rootDir: root });
    try {
      for (const probe of [
        { headers: { host: "127.0.0.1:8787" } },
        { headers: { host: "evil.example", origin: headers.origin } },
        { headers: { host: headers.host, origin: "http://evil.example" } },
        { headers, remoteAddress: "198.51.100.3" },
      ]) {
        for (const url of ["/api/skills/install", "/api/%73kills/install"]) {
          const response = await app.inject({ method: "POST", url, payload: { agent: "claude" }, ...probe });
          assert.equal(response.statusCode, 403, url);
          assert.deepEqual(response.json(), { error: "invalid request" });
        }
      }
      await assert.rejects(stat(join(root, ".claude")), { code: "ENOENT" });
      const dev = await app.inject({ method: "POST", url: "/api/skills/install", headers: { host: headers.host, origin: "http://localhost:5173" }, payload: { agent: "claude" } });
      assert.equal(dev.statusCode, 201);
    } finally { await app.close(); }
  });
});

test("swapping the pinned root before install fails closed", async () => {
  await withProject(async (parent) => {
    const root = join(parent, "project");
    const replacement = join(parent, "replacement");
    await Promise.all([mkdir(root), mkdir(replacement)]);
    const app = buildServer({ mode: "workspace", rootDir: root });
    try {
      await rename(root, join(parent, "old-project"));
      await symlink(replacement, root, "dir");
      const response = await app.inject({ method: "POST", url: "/api/skills/install", headers, payload: { agent: "hermes" } });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.json(), { error: "skill install unavailable" });
      await assert.rejects(stat(join(replacement, ".hermes")), { code: "ENOENT" });
    } finally { await app.close(); }
  });
});
