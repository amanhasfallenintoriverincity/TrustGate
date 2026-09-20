import { pathToFileURL } from "node:url";

import {
  CONTRACT_JSON_MAX_BYTES,
  analysisPlanSchema,
  executionResultSchema,
  jsonValueSchema,
  parseContractJson,
  type AnalysisPlan,
  type ExecutionResult,
} from "@trustgate/contracts";
import {
  runTestSpec as defaultRunTestSpec,
  type SendRequest,
} from "@trustgate/orchestrator/spec-runner";
import type { FastifyInstance } from "fastify";

import { buildServer as defaultBuildServer } from "./server.js";
import type { Mode } from "./store.js";

export const FETCH_TIMEOUT_MS = 5_000;
const FATAL_MESSAGE = "sandbox execution failed\n";
const LOOPBACK_HOST = "127.0.0.1";

export type SandboxInput = AsyncIterable<string | Uint8Array>;

type ExecuteDependencies = {
  buildServer?: (mode: Mode) => FastifyInstance;
  runTestSpec?: typeof defaultRunTestSpec;
  fetch?: typeof fetch;
};

type MainOptions = ExecuteDependencies & {
  stdin: SandboxInput;
  targetMode: string | undefined;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
};

export const parseTargetMode = (value: string | undefined): Mode => {
  if (value !== "vulnerable" && value !== "patched") {
    throw new TypeError("invalid sandbox mode");
  }
  return value;
};

export const readBoundedStdin = async (input: SandboxInput): Promise<string> => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    for await (const chunk of input) {
      const value = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      bytes += value.byteLength;
      if (bytes > CONTRACT_JSON_MAX_BYTES) {
        throw new RangeError("sandbox input rejected");
      }
      chunks.push(value);
    }
    return decoder.decode(Buffer.concat(chunks));
  } catch {
    throw new Error("sandbox input rejected");
  }
};

const assertLoopbackOrigin = (origin: string): URL => {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== LOOPBACK_HOST ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.port === ""
  ) {
    throw new TypeError("invalid loopback origin");
  }
  return parsed;
};

const assertRelativeRequestPath = (path: string): void => {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(path)
  ) {
    throw new TypeError("invalid loopback path");
  }
};

const readBoundedResponseText = async (response: Response): Promise<string> => {
  if (response.body === null) return "null";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > CONTRACT_JSON_MAX_BYTES) {
        await reader.cancel();
        throw new RangeError("response JSON rejected");
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error("response JSON rejected");
  } finally {
    reader.releaseLock();
  }
};

export const createLoopbackSendRequest = (
  origin: string,
  fetchImplementation: typeof fetch = fetch,
): SendRequest => {
  const trustedOrigin = assertLoopbackOrigin(origin);

  return async (path, init) => {
    assertRelativeRequestPath(path);
    const url = new URL(path, trustedOrigin);
    if (url.origin !== trustedOrigin.origin) {
      throw new TypeError("invalid loopback path");
    }

    const hasBody = init.body !== undefined;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init.headers)) {
      if (key.toLowerCase() !== "content-type") headers[key] = value;
    }
    if (hasBody) headers["content-type"] = "application/json";

    const response = await fetchImplementation(url, {
      method: init.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await readBoundedResponseText(response);
    const json = parseContractJson(jsonValueSchema, text === "" ? "null" : text);
    return { status: response.status, json };
  };
};

const listenOnLoopback = async (server: FastifyInstance): Promise<string> => {
  const address = await server.listen({ host: LOOPBACK_HOST, port: 0 });
  const parsed = assertLoopbackOrigin(address);
  return parsed.origin;
};

const assertUniqueTestIds = (plan: AnalysisPlan): void => {
  const seen = new Set<string>();
  for (const hypothesis of plan.hypotheses) {
    for (const spec of hypothesis.tests) {
      if (seen.has(spec.id)) throw new Error("duplicate test identity");
      seen.add(spec.id);
    }
  }
};

export const executeAnalysisPlan = async (
  plan: AnalysisPlan,
  mode: Mode,
  dependencies: ExecuteDependencies = {},
): Promise<ExecutionResult[]> => {
  assertUniqueTestIds(plan);
  const buildServer = dependencies.buildServer ?? defaultBuildServer;
  const runTestSpec = dependencies.runTestSpec ?? defaultRunTestSpec;
  const fetchImplementation = dependencies.fetch ?? fetch;
  const results: ExecutionResult[] = [];

  for (const hypothesis of plan.hypotheses) {
    for (const spec of hypothesis.tests) {
      const server = buildServer(mode);
      try {
        const origin = await listenOnLoopback(server);
        const result = await runTestSpec(
          spec,
          createLoopbackSendRequest(origin, fetchImplementation),
        );
        results.push(
          executionResultSchema.parse({
            ...result,
            runId: `spec-${spec.id}`,
            hypothesisId: hypothesis.id,
          }),
        );
      } finally {
        await server.close();
      }
    }
  }

  return executionResultSchema.array().max(50).parse(results);
};

export const runSandboxMain = async (options: MainOptions): Promise<0 | 1> => {
  try {
    const mode = parseTargetMode(options.targetMode);
    const text = await readBoundedStdin(options.stdin);
    const plan = parseContractJson(analysisPlanSchema, text);
    const results = await executeAnalysisPlan(plan, mode, options);
    options.writeStdout(`${JSON.stringify(results)}\n`);
    return 0;
  } catch {
    options.writeStderr(FATAL_MESSAGE);
    return 1;
  }
};

const isDirectExecution = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
};

if (isDirectExecution()) {
  process.exitCode = await runSandboxMain({
    stdin: process.stdin,
    targetMode: process.env.TARGET_MODE,
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  });
}
