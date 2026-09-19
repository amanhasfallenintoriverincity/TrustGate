import { buildServer } from "./server.js";

const mode = process.env.TARGET_MODE;
if (mode !== "vulnerable" && mode !== "patched") {
  throw new Error('TARGET_MODE must be exactly "vulnerable" or "patched"');
}

const host = process.env.HOST ?? "0.0.0.0";
const portValue = process.env.PORT ?? "3001";
const port = Number(portValue);
if (!Number.isFinite(port) || !Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("PORT must be a finite integer between 0 and 65535");
}

await buildServer(mode).listen({ host, port });
