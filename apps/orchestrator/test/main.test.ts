import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
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
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: APP_DIR,
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
