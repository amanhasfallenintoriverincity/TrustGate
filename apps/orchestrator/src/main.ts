/**
 * CLI entry point for the TrustGate run API.
 *
 * Environment:
 * - `TRUSTGATE_MODE` (`fixture` | `workspace`, default `fixture`; any other value refuses to start)
 * - `TRUSTGATE_HOST` / `TRUSTGATE_PORT` (default 127.0.0.1:8787)
 * - workspace runs additionally need `TRUSTGATE_LLM_BASE_URL`, `TRUSTGATE_LLM_MODEL`,
 *   and `TRUSTGATE_SANDBOX_IMAGE`.
 *
 * Logs are JSON lines built from the server's non-sensitive log records only. Configuration and
 * listen failures emit a fixed `{"event":"server.failed","reason":...}` record: never a stack
 * trace, a host path, or a framework message. Shutdown stops accepting work, gives in-flight
 * runs `SHUTDOWN_GRACE_MS` to finish, then forces the exit with a matching log record.
 */
import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { buildServer, type RunLogRecord, type ServerMode } from "./server.js";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const SHUTDOWN_GRACE_MS = 10_000;

export type ConfigFailureReason = "invalid_mode" | "invalid_port";
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

export const readPort = (value: string | undefined): number => {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError("invalid_port");
  }
  return port;
};

/**
 * Writes one JSON line. `writeSync` keeps the record intact when the process exits immediately
 * afterwards: buffered pipe output would otherwise be dropped on a forced shutdown.
 */
export const writeLog = (record: ServerLogRecord | RunLogRecord): void => {
  const line = `${JSON.stringify(record)}\n`;
  try {
    writeSync(process.stdout.fd, line);
  } catch {
    process.stdout.write(line);
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

/** True when this module is the process entry point (importing it must not start a server). */
const isDirectRun = (moduleUrl: string): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(entry).href;
  } catch {
    return false;
  }
};

export const run = async (): Promise<void> => {
  const log = (record: ServerLogRecord): void => writeLog(record);

  let mode: ServerMode;
  let host: string;
  let port: number;
  try {
    mode = readMode(process.env.TRUSTGATE_MODE);
    host = process.env.TRUSTGATE_HOST ?? DEFAULT_HOST;
    port = readPort(process.env.TRUSTGATE_PORT);
  } catch (error) {
    log({
      event: "server.failed",
      reason: error instanceof ConfigError ? error.reason : "invalid_mode",
    });
    process.exitCode = 1;
    return;
  }

  const app = buildServer({ mode, log: (record) => writeLog(record) });
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
