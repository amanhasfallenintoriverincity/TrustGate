import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
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
