/**
 * CLI entry point for the TrustGate run API.
 *
 * Environment:
 * - `TRUSTGATE_MODE` (`fixture` | `workspace`, default `fixture`; any other value refuses to start)
 * - `TRUSTGATE_WORKSPACE_ROOT` (required in workspace mode: absolute existing directory
 *   selected by the operator; fixture mode ignores it)
 * - `TRUSTGATE_HOST` / `TRUSTGATE_PORT` (default 127.0.0.1:8787)
 * - workspace runs use nonsecret settings saved by `/api/setup` first, falling back to
 *   `TRUSTGATE_LLM_BASE_URL`, `TRUSTGATE_LLM_MODEL`, and `TRUSTGATE_SANDBOX_IMAGE`.
 *   Save does not connect; `/api/setup/test` explicitly tests the configured endpoint.
 *
 * Logs are JSON lines built from the server's non-sensitive log records only. Configuration and
 * listen failures emit a fixed `{"event":"server.failed","reason":...}` record: never a stack
 * trace, a host path, or a framework message. Shutdown stops accepting work, gives in-flight
 * runs `SHUTDOWN_GRACE_MS` to finish, then forces the exit with a matching log record.
 *
 * Every line passes through the central redaction layer in `redaction.ts` on its way to stdout —
 * the one place the process emits output — so a credential that reaches a record field is
 * removed before it is written. A record that cannot be serialized or redacted is replaced by
 * `REDACTION_FAILURE_LINE`, never written raw and never dropped silently.
 */
import { realpathSync, statSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { serializeLogLine } from "./redaction.js";
import { buildServer, type RunLogRecord, type ServerMode } from "./server.js";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const SHUTDOWN_GRACE_MS = 10_000;

export type ConfigFailureReason = "invalid_mode" | "invalid_port" | "invalid_workspace_root";
export type ServerFailureReason = ConfigFailureReason | "listen" | "shutdown";

/** Every record this entry point can write; a closed union of non-sensitive fields. */
export type ServerLogRecord =
  | { event: "server.started"; mode: ServerMode; host: string; port: number }
  | { event: "server.failed"; reason: ServerFailureReason }
  | { event: "server.shutdown"; signal: NodeJS.Signals }
  | { event: "server.shutdown.timeout"; signal: NodeJS.Signals }
  | { event: "server.stopped" };

/** Raised for environment values that are present but unusable. */
export class ConfigError extends Error {
  readonly reason: ConfigFailureReason;

  constructor(reason: ConfigFailureReason) {
    super(`invalid configuration: ${reason}`);
    this.name = "ConfigError";
    this.reason = reason;
  }
}

/** Unknown mode values must fail loudly: silently downgrading to `fixture` hides a typo. */
export const readMode = (value: string | undefined): ServerMode => {
  if (value === undefined) return "fixture";
  if (value === "fixture" || value === "workspace") return value;
  throw new ConfigError("invalid_mode");
};

/**
 * Ports are read as a plain decimal string. `Number()` alone would also accept notations that no
 * operator writes on purpose (`0x10`, `1e3`, `00123`), so the shape is checked before the range.
 * The pattern also rejects a leading zero, which keeps `"00123"` from silently meaning `123`.
 */
const PORT_PATTERN = /^[1-9]\d{0,4}$/;

export const readPort = (value: string | undefined): number => {
  if (value === undefined) return DEFAULT_PORT;
  if (!PORT_PATTERN.test(value)) throw new ConfigError("invalid_port");
  const port = Number(value);
  if (port > 65_535) throw new ConfigError("invalid_port");
  return port;
};

/** Only an operator-selected absolute directory can become the workspace allowlist root. */
export const readWorkspaceRoot = (value: string | undefined, mode: ServerMode): string | undefined => {
  if (mode === "fixture") return undefined;
  if (value === undefined || !isAbsolute(value)) throw new ConfigError("invalid_workspace_root");
  try {
    const realPath = realpathSync(value);
    if (statSync(realPath).isDirectory()) return value;
  } catch {
    // Missing paths and inaccessible directories fail before the server begins listening.
  }
  throw new ConfigError("invalid_workspace_root");
};

let stdoutErrorGuarded = false;

/**
 * A reader that goes away (a closed pipe, a terminal that exits) leaves `process.stdout`
 * permanently broken; without a listener its `error` event is unhandled and takes the process
 * down. Install one listener, once, before the first write: a lost diagnostic record is
 * acceptable, a crash is not.
 */
const guardStdoutErrors = (): void => {
  if (stdoutErrorGuarded) return;
  stdoutErrorGuarded = true;
  process.stdout.on("error", () => {});
};

/**
 * Writes one JSON line. The record is serialized and redacted first (`serializeLogLine`), so raw
 * field values can never reach the stream. `writeSync` keeps the line intact when the process
 * exits immediately afterwards: buffered pipe output would otherwise be dropped on a forced
 * shutdown. Both writes are best-effort — if the stream is gone, the line is lost and the process
 * carries on.
 */
export const writeLog = (record: ServerLogRecord | RunLogRecord): void => {
  const line = serializeLogLine(record);
  guardStdoutErrors();
  try {
    writeSync(process.stdout.fd, line);
    return;
  } catch {
    // `writeSync` cannot report a closed pipe to the stream; fall through to the stream API.
  }
  try {
    process.stdout.write(line);
  } catch {
    // The stream is destroyed beyond recovery: drop the record.
  }
};

export type ShutdownOptions = {
  close: () => Promise<unknown>;
  log: (record: ServerLogRecord) => void;
  exit: (code: number) => void;
  /** Grace period before the exit is forced. Defaults to `SHUTDOWN_GRACE_MS`. */
  graceMs?: number;
};

/**
 * Builds the SIGINT/SIGTERM handler. A run that never settles must not keep the process alive,
 * so the grace timer is `unref`ed and forces an exit with a log record of its own; a normal
 * close clears it. Repeated signals are ignored while shutdown is already under way.
 */
export const createShutdownHandler = (
  options: ShutdownOptions,
): ((signal: NodeJS.Signals) => void) => {
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  let shuttingDown = false;

  return (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.log({ event: "server.shutdown", signal });

    const forcedExit = setTimeout(() => {
      options.log({ event: "server.shutdown.timeout", signal });
      options.exit(1);
    }, graceMs);
    forcedExit.unref();

    void options.close().then(
      () => {
        clearTimeout(forcedExit);
        options.log({ event: "server.stopped" });
        options.exit(0);
      },
      () => {
        clearTimeout(forcedExit);
        options.log({ event: "server.failed", reason: "shutdown" });
        options.exit(1);
      },
    );
  };
};

export const installShutdownHandlers = (options: ShutdownOptions): void => {
  const handle = createShutdownHandler(options);
  process.on("SIGINT", handle);
  process.on("SIGTERM", handle);
};

/**
 * True when this module is the process entry point (importing it must not start a server). Both
 * sides are resolved to their real path: a symlinked, relative, or `..`-containing entry path
 * names the same file as the module URL, and comparing the raw strings would silently skip
 * `run()` and exit 0 as if everything were fine.
 */
const isDirectRun = (moduleUrl: string): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
};

export const run = async (): Promise<void> => {
  const log = (record: ServerLogRecord): void => writeLog(record);

  let mode: ServerMode;
  let host: string;
  let port: number;
  let rootDir: string | undefined;
  try {
    mode = readMode(process.env.TRUSTGATE_MODE);
    host = process.env.TRUSTGATE_HOST ?? DEFAULT_HOST;
    port = readPort(process.env.TRUSTGATE_PORT);
    rootDir = readWorkspaceRoot(process.env.TRUSTGATE_WORKSPACE_ROOT, mode);
  } catch (error) {
    log({
      event: "server.failed",
      reason: error instanceof ConfigError ? error.reason : "invalid_mode",
    });
    process.exitCode = 1;
    return;
  }

  const app = buildServer({ mode, ...(rootDir === undefined ? {} : { rootDir }), log: (record) => writeLog(record) });
  installShutdownHandlers({
    close: () => app.close(),
    log,
    exit: (code) => process.exit(code),
  });

  try {
    await app.listen({ host, port });
    log({ event: "server.started", mode, host, port });
  } catch {
    log({ event: "server.failed", reason: "listen" });
    process.exitCode = 1;
  }
};

if (isDirectRun(import.meta.url)) {
  await run();
}
