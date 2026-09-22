/**
 * CLI entry point for the TrustGate run API.
 *
 * Environment:
 * - `TRUSTGATE_MODE` (fixture | workspace, default `fixture`)
 * - `TRUSTGATE_HOST` / `TRUSTGATE_PORT` (default 127.0.0.1:8787)
 * - workspace runs additionally need `TRUSTGATE_LLM_BASE_URL`, `TRUSTGATE_LLM_MODEL`,
 *   and `TRUSTGATE_SANDBOX_IMAGE`.
 *
 * Logs are JSON lines built from the server's non-sensitive log records only.
 */
import { buildServer, type ServerMode } from "./server.js";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";

const readMode = (value: string | undefined): ServerMode =>
  value === "workspace" ? "workspace" : "fixture";

const readPort = (value: string | undefined): number => {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid TRUSTGATE_PORT");
  }
  return port;
};

const writeLog = (record: unknown): void => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

const mode = readMode(process.env.TRUSTGATE_MODE);
const host = process.env.TRUSTGATE_HOST ?? DEFAULT_HOST;
const port = readPort(process.env.TRUSTGATE_PORT);

const app = buildServer({ mode, log: writeLog });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ host, port });
  writeLog({ event: "server.started", mode, host, port });
} catch {
  writeLog({ event: "server.failed" });
  process.exitCode = 1;
}
