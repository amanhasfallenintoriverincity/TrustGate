import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ConfigError,
  createShutdownHandler,
  readMode,
  readPort,
  type ServerLogRecord,
} from "../src/main.js";
import { buildServer, WorkspaceUnavailableError, type RunTask } from "../src/server.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(MODULE_DIR, "..");

const withTimeout = async <Value>(
  promise: Promise<Value>,
  label: string,
  ms = 25_000,
): Promise<Value> =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), ms).unref();
    }),
  ]);

const waitFor = async (
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`${label} did not happen in time`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("no ephemeral port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });

type SpawnedMain = {
  child: ChildProcess;
  output: { stdout: string; stderr: string };
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

/** Starts the real entry point; no port is bound unless the configuration is valid. */
const spawnMain = (env: Record<string, string>): SpawnedMain => {
  // Spawn tests must not inherit live provider settings and accidentally invoke paid calls.
  const inherited = { ...process.env };
  for (const key of ["TRUSTGATE_WORKSPACE_ROOT", "TRUSTGATE_LLM_BASE_URL", "TRUSTGATE_LLM_MODEL", "TRUSTGATE_SANDBOX_IMAGE"]) {
    delete inherited[key];
  }
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: APP_DIR,
    env: { ...inherited, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout?.on("data", (chunk: Buffer) => (output.stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output.stderr += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  return { child, output, exited };
};

const jsonLines = (text: string): unknown[] =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);

/** Stack traces, framework messages, and host paths must never reach the operator's terminal. */
const assertNoInternalDetail = (text: string): void => {
  assert.ok(!text.includes("src/main.ts"), "leaked a source reference");
  assert.ok(!/\n\s+at /.test(text), "leaked a stack frame");
  assert.ok(!/\bError\b|throw new/.test(text), "leaked an error name or throw site");
  for (const absolute of [process.cwd(), APP_DIR, MODULE_DIR]) {
    assert.ok(!text.includes(absolute), `leaked the host path ${absolute}`);
  }
};

test("readMode accepts only the documented mode values", () => {
  assert.equal(readMode(undefined), "fixture");
  assert.equal(readMode("fixture"), "fixture");
  assert.equal(readMode("workspace"), "workspace");

  for (const value of ["Workspace", "WORKSPACE", "fixture ", "", "remote"]) {
    assert.throws(
      () => readMode(value),
      (error: unknown) =>
        error instanceof ConfigError && error.reason === "invalid_mode",
      `expected invalid_mode for ${JSON.stringify(value)}`,
    );
  }
});

test("readPort rejects unusable values with a typed error", () => {
  assert.equal(readPort(undefined), 8787);
  assert.equal(readPort("1"), 1);
  assert.equal(readPort("8787"), 8787);
  assert.equal(readPort("65535"), 65_535);

  for (const value of ["abc", "", "0", "-1", "65536", "1.5", "80abc"]) {
    assert.throws(
      () => readPort(value),
      (error: unknown) =>
        error instanceof ConfigError && error.reason === "invalid_port",
      `expected invalid_port for ${JSON.stringify(value)}`,
    );
  }
});

test("shutdown waits for in-flight work and then exits cleanly", async () => {
  const records: ServerLogRecord[] = [];
  const exits: number[] = [];
  let closeCalls = 0;
  const handle = createShutdownHandler({
    close: async () => {
      closeCalls += 1;
    },
    log: (record) => records.push(record),
    exit: (code) => exits.push(code),
    graceMs: 30,
  });

  handle("SIGINT");
  await waitFor(() => exits.length > 0, "graceful exit");
  assert.deepEqual(exits, [0]);
  assert.equal(closeCalls, 1);
  assert.deepEqual(
    records.map((record) => record.event),
    ["server.shutdown", "server.stopped"],
  );

  // The grace timer was cleared: waiting past it must not force another exit.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(exits, [0]);
});

test("shutdown forces an exit when a run never settles", async () => {
  const records: ServerLogRecord[] = [];
  const exits: number[] = [];
  const neverSettles = new Promise<never>(() => {});
  const handle = createShutdownHandler({
    close: () => neverSettles,
    log: (record) => records.push(record),
    exit: (code) => exits.push(code),
    graceMs: 30,
  });

  handle("SIGTERM");
  handle("SIGINT"); // repeated signals while shutting down are ignored
  await waitFor(() => exits.length > 0, "forced exit");
  assert.deepEqual(exits, [1]);
  assert.deepEqual(
    records.map((record) => record.event),
    ["server.shutdown", "server.shutdown.timeout"],
  );
  const shutdown = records.find(
    (record): record is Extract<ServerLogRecord, { event: "server.shutdown" }> =>
      record.event === "server.shutdown",
  );
  assert.equal(shutdown?.signal, "SIGTERM");
});

test("an unknown TRUSTGATE_MODE refuses to start with a JSON-only log line", async () => {
  const { child, output, exited } = spawnMain({
    TRUSTGATE_MODE: "Workspace",
    TRUSTGATE_PORT: "18787",
    TRUSTGATE_HOST: "127.0.0.1",
  });

  try {
    const result = await withTimeout(exited, "invalid mode run");
    assert.equal(result.signal, null);
    assert.equal(result.code, 1);
    assert.deepEqual(jsonLines(output.stdout), [
      { event: "server.failed", reason: "invalid_mode" },
    ]);
    assert.equal(output.stderr, "", "stderr must stay empty for a config failure");
    assertNoInternalDetail(output.stdout + output.stderr);
  } finally {
    child.kill("SIGKILL");
  }
});

test("an unparsable TRUSTGATE_PORT exits with a JSON-only log line", async () => {
  const { child, output, exited } = spawnMain({
    TRUSTGATE_MODE: "fixture",
    TRUSTGATE_PORT: "abc",
  });

  try {
    const result = await withTimeout(exited, "invalid port run");
    assert.equal(result.signal, null);
    assert.equal(result.code, 1);
    assert.deepEqual(jsonLines(output.stdout), [
      { event: "server.failed", reason: "invalid_port" },
    ]);
    assert.equal(output.stderr, "", "stderr must stay empty for a config failure");
    assertNoInternalDetail(output.stdout + output.stderr);
  } finally {
    child.kill("SIGKILL");
  }
});

test("SIGINT stops the entry point with a graceful shutdown record", async () => {
  const port = await freePort();
  const { child, output, exited } = spawnMain({
    TRUSTGATE_MODE: "fixture",
    TRUSTGATE_PORT: String(port),
    TRUSTGATE_HOST: "127.0.0.1",
  });

  try {
    await waitFor(
      () => output.stdout.includes("server.started"),
      "server.started record",
    );
    child.kill("SIGINT");
    const result = await withTimeout(exited, "SIGINT shutdown");
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
    assert.deepEqual(
      jsonLines(output.stdout).map((line) => (line as { event: string }).event),
      ["server.started", "server.shutdown", "server.stopped"],
    );
    assertNoInternalDetail(output.stdout + output.stderr);
  } finally {
    child.kill("SIGKILL");
  }
});

test("the entry point binds its mode to the run API it serves", async () => {
  const scratch = process.env.TMPDIR ?? tmpdir();
  const root = await mkdtemp(join(scratch, "trustgate-main-mode-"));
  const port = await freePort();
  const { child, output, exited } = spawnMain({
    TRUSTGATE_MODE: "fixture",
    TRUSTGATE_PORT: String(port),
    TRUSTGATE_HOST: "127.0.0.1",
    TRUSTGATE_WORKSPACE_ROOT: join(root, "not-an-existing-directory"),
    XDG_CONFIG_HOME: root,
  });

  try {
    await waitFor(
      () => output.stdout.includes("server.started"),
      "server.started record",
    );
    const started = jsonLines(output.stdout).find(
      (line) => (line as { event?: string }).event === "server.started",
    ) as { mode?: string; port?: number };
    assert.equal(started.mode, "fixture");
    assert.equal(started.port, port);

    const setup = await fetch(`http://127.0.0.1:${port}/api/setup`);
    assert.equal(setup.status, 200);
    assert.deepEqual(await setup.json(), { mode: "fixture", configured: false, settings: null });
    const saved = await fetch(`http://127.0.0.1:${port}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ kind: "openai-compatible", baseUrl: "http://127.0.0.1:9999/v1", model: "local", apiKeyEnv: "", sandboxImage: "localhost/trustgate-target:latest" }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).mode, "fixture");

    const workspace = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "workspace", repoPath: root }),
    });
    assert.equal(workspace.status, 400);

    child.kill("SIGTERM");
    await withTimeout(exited, "SIGTERM shutdown");
  } finally {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------------------------------------
// Startup logging and entry detection: a broken log stream and a non-canonical entry path must not
// turn a healthy server into a silent no-op or a crash.
// -------------------------------------------------------------------------------------------------

/** Repository root: the entry point is normally reached through it. */
const REPO_ROOT = join(APP_DIR, "..", "..");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Mirrors `spawnMain`, but takes the full argv so the entry path itself can vary. */
const spawnEntry = (
  args: readonly string[],
  env: Record<string, string>,
  cwd: string = APP_DIR,
): SpawnedMain => {
  const child = spawn(process.execPath, [...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout?.on("data", (chunk: Buffer) => (output.stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output.stderr += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  return { child, output, exited };
};

/**
 * Starts the entry point through an arbitrary argv and asserts the full happy cycle: a
 * `server.started` record, a graceful SIGTERM shutdown, and no internal detail anywhere.
 */
const expectGracefulStart = async (
  args: readonly string[],
  env: Record<string, string>,
  cwd: string = APP_DIR,
): Promise<{ stdout: string; stderr: string }> => {
  const { child, output, exited } = spawnEntry(args, env, cwd);
  let exitedEarly: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  void exited.then((value) => {
    exitedEarly = value;
  });

  try {
    await waitFor(
      () => output.stdout.includes("server.started") || exitedEarly !== null,
      "server.started record",
    );
    assert.ok(
      output.stdout.includes("server.started"),
      `no startup record; the process exited as ${JSON.stringify(exitedEarly)}`,
    );

    child.kill("SIGTERM");
    const result = await withTimeout(exited, "graceful shutdown");
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
    assert.deepEqual(
      jsonLines(output.stdout).map((line) => (line as { event: string }).event),
      ["server.started", "server.shutdown", "server.stopped"],
    );
    assertNoInternalDetail(output.stdout + output.stderr);
    return output;
  } finally {
    child.kill("SIGKILL");
  }
};

test("readPort demands a plain decimal port string", () => {
  assert.equal(readPort("1"), 1);
  assert.equal(readPort("8787"), 8787);
  assert.equal(readPort("65535"), 65_535);

  for (const value of ["0x10", "1e3", "00123", "0b101", " 8787", "8787 ", "+8787", "8787.0"]) {
    assert.throws(
      () => readPort(value),
      (error: unknown) =>
        error instanceof ConfigError && error.reason === "invalid_port",
      `expected invalid_port for ${JSON.stringify(value)}`,
    );
  }
});

test("a log stream that breaks mid-run neither crashes nor stops the server", async () => {
  const port = await freePort();
  const { child, output, exited } = spawnMain({
    TRUSTGATE_MODE: "fixture",
    TRUSTGATE_PORT: String(port),
    TRUSTGATE_HOST: "127.0.0.1",
  });
  let exitedEarly: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  void exited.then((value) => {
    exitedEarly = value;
  });

  try {
    await waitFor(
      () => output.stdout.includes("server.started"),
      "server.started record",
    );

    // Whoever reads the log stream goes away: every later write fails with EPIPE.
    child.stdout?.destroy();

    // An unparsable request line reaches the parse-level handler, which logs on the dead stream.
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`${"x".repeat(9 * 1024)}\r\n\r\n`);
    });
    socket.on("error", () => {});
    setTimeout(() => socket.destroy(), 250).unref();

    await sleep(500);
    // A dead log stream may cost records; it must not cost the process or leak a stack trace.
    assert.deepEqual(
      { stderr: output.stderr, exit: exitedEarly },
      { stderr: "", exit: null },
      "a broken log stream crashed the server",
    );
    assertNoInternalDetail(output.stdout + output.stderr);

    // Losing diagnostic records is acceptable; losing the service is not.
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);

    child.kill("SIGTERM");
    const result = await withTimeout(exited, "shutdown on a broken log stream");
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
    assert.equal(output.stderr, "", "shutdown on a broken log stream wrote to stderr");
    assertNoInternalDetail(output.stdout + output.stderr);
  } finally {
    child.kill("SIGKILL");
  }
});

test("the entry point starts when its file is reached through a symlinked path", async () => {
  const scratch = process.env.TMPDIR ?? tmpdir();
  const linkDir = await mkdtemp(join(scratch, "trustgate-main-link-"));
  const port = await freePort();

  try {
    const linkedTree = join(linkDir, "tree");
    await symlink(REPO_ROOT, linkedTree, "dir");

    await expectGracefulStart(
      ["--import", "tsx", join(linkedTree, "apps", "orchestrator", "src", "main.ts")],
      {
        TRUSTGATE_MODE: "fixture",
        TRUSTGATE_PORT: String(port),
        TRUSTGATE_HOST: "127.0.0.1",
      },
    );
  } finally {
    await rm(linkDir, { recursive: true, force: true });
  }
});

test("the entry point starts when it is reached through a relative path", async () => {
  const scratch = process.env.TMPDIR ?? tmpdir();
  const linkDir = await mkdtemp(join(scratch, "trustgate-main-relative-"));
  const port = await freePort();

  try {
    // The checkout is reached relatively, through a symlinked directory, and the entry path
    // itself carries a `..` segment. `node_modules` is linked alongside so the loader resolves.
    await symlink(REPO_ROOT, join(linkDir, "tree"), "dir");
    await symlink(join(REPO_ROOT, "node_modules"), join(linkDir, "node_modules"), "dir");

    await expectGracefulStart(
      ["--import", "tsx", "tree/apps/orchestrator/../orchestrator/src/main.ts"],
      {
        TRUSTGATE_MODE: "fixture",
        TRUSTGATE_PORT: String(port),
        TRUSTGATE_HOST: "127.0.0.1",
      },
      linkDir,
    );
  } finally {
    await rm(linkDir, { recursive: true, force: true });
  }
});

test("importing the entry point without an entry argument starts nothing", async () => {
  const { child, output, exited } = spawnEntry([
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    'await import("./src/main.ts");',
  ], {});

  try {
    const result = await withTimeout(exited, "import-only run");
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
    assert.equal(output.stdout, "", "an imported entry point started a server");
    assert.equal(output.stderr, "");
  } finally {
    child.kill("SIGKILL");
  }
});

test("workspace entry point uses only the explicit project root and rejects escapes", async () => {
  const isolated = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "trustgate-main-root-"));
  const project = join(isolated, "different-project");
  const sibling = join(isolated, "sibling");
  await mkdir(join(project, "repo"), { recursive: true });
  await mkdir(sibling);
  await symlink(sibling, join(project, "escape"), "dir");
  const port = await freePort();
  const { child, output, exited } = spawnMain({
    TRUSTGATE_MODE: "workspace",
    TRUSTGATE_WORKSPACE_ROOT: project,
    TRUSTGATE_PORT: String(port),
    TRUSTGATE_HOST: "127.0.0.1",
    XDG_CONFIG_HOME: isolated,
  });
  try {
    await waitFor(() => output.stdout.includes("server.started"), "workspace server.started record");
    const endpoint = `http://127.0.0.1:${port}`;
    const setup = await fetch(`${endpoint}/api/setup`);
    assert.equal(setup.status, 200);
    assert.deepEqual(await setup.json(), { mode: "workspace", configured: false, settings: null });
    const run = (repoPath?: string) => fetch(`${endpoint}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "workspace", ...(repoPath === undefined ? {} : { repoPath }) }),
    });
    // No settings are present: accepted paths reach the unavailable gate, without LLM calls.
    assert.equal((await run("repo")).status, 503);
    assert.equal((await run()).status, 503);
    for (const rejected of ["../sibling", "repo/../escape", "escape", sibling]) {
      const response = await run(rejected);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid repository path" });
    }
    assertNoInternalDetail(output.stdout + output.stderr);
    assert.ok(!output.stdout.includes(project));
    child.kill("SIGTERM");
    assert.equal((await withTimeout(exited, "workspace shutdown")).code, 0);
  } finally {
    child.kill("SIGKILL");
    await rm(isolated, { recursive: true, force: true });
  }
});

test("workspace root must be an explicitly configured absolute existing directory", async () => {
  const isolated = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "trustgate-main-bad-root-"));
  const file = join(isolated, "file");
  await writeFile(file, "not a directory");
  try {
    for (const root of [undefined, "", "relative-project", join(isolated, "missing"), file]) {
      const { child, output, exited } = spawnMain({
        TRUSTGATE_MODE: "workspace",
        TRUSTGATE_HOST: "127.0.0.1",
        TRUSTGATE_PORT: String(await freePort()),
        ...(root === undefined ? {} : { TRUSTGATE_WORKSPACE_ROOT: root }),
      });
      try {
        assert.deepEqual(await withTimeout(exited, "invalid workspace root"), { code: 1, signal: null });
        assert.deepEqual(jsonLines(output.stdout), [{ event: "server.failed", reason: "invalid_workspace_root" }]);
        assert.equal(output.stderr, "");
        assert.ok(!output.stdout.includes(isolated));
        assertNoInternalDetail(output.stdout + output.stderr);
      } finally { child.kill("SIGKILL"); }
    }
  } finally { await rm(isolated, { recursive: true, force: true }); }
});

test("workspace server passes canonical in-root paths to an injected no-cost executor", async () => {
  const isolated = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "trustgate-main-normalize-"));
  const project = join(isolated, "project");
  const repo = join(project, "repo");
  const outside = join(isolated, "outside");
  await mkdir(repo, { recursive: true });
  await mkdir(outside);
  await symlink(repo, join(project, "alias"), "dir");
  await symlink(outside, join(project, "escape"), "dir");
  const tasks: RunTask[] = [];
  const app = buildServer({
    mode: "workspace",
    rootDir: project,
    executeRun: async (task) => { tasks.push(task); throw new WorkspaceUnavailableError(); },
  });
  try {
    for (const path of ["repo", "alias", undefined]) {
      const response = await app.inject({ method: "POST", url: "/api/runs", payload: { source: "workspace", ...(path === undefined ? {} : { repoPath: path }) } });
      assert.equal(response.statusCode, 503);
    }
    assert.deepEqual(tasks.map((task) => task.repoPath), [await realpath(repo), await realpath(repo), await realpath(project)]);
    for (const path of ["escape", "../outside", "repo/../escape", outside]) {
      const response = await app.inject({ method: "POST", url: "/api/runs", payload: { source: "workspace", repoPath: path } });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(tasks.length, 3);
  } finally {
    await app.close();
    await rm(isolated, { recursive: true, force: true });
  }
});
