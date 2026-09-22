/**
 * TrustGate run API.
 *
 * - `fixture` mode replays `fixture-plan.json` (pure JSON data). It needs no LLM, no
 *   Podman, and no network, so the whole pipeline stays demonstrable on any machine.
 * - `workspace` mode normalizes the requested repository path against an allowlisted
 *   root and runs OCR -> diffs -> planner -> sandbox -> report.
 *
 * Leak posture: responses and logs never carry credentials, prompts, request bodies, or
 * raw host paths. Errors are fixed generic strings, log records are a closed union of
 * non-sensitive metadata fields, and Fastify's own logger stays disabled because it
 * captures raw request headers (including `authorization`). On top of that, every record
 * handed to a log sink passes through the central redaction layer (`redaction.ts`), which
 * is wired once at the sink in `buildServer` — a value that still reaches a field is
 * removed before any sink can observe it.
 */
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { STATUS_CODES } from "node:http";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analysisPlanSchema,
  executionResultSchema,
  type AnalysisPlan,
  type ExecutionResult,
} from "@trustgate/contracts";
import { createLlmClient, LlmGatewayError } from "@trustgate/llm-gateway";
import Fastify, {
  type ConnectionError,
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";

import { collectDiffs, type FileDiff } from "./diff-collector.js";
import { createOcrAdapter, type ReviewInput } from "./ocr-adapter.js";
import { createSecurityPlanner, type PlannerInput } from "./planner.js";
import { createRedactingSink } from "./redaction.js";
import {
  createRunReport,
  type ReportDurations,
  type RunReport,
} from "./report.js";
import type { SandboxMode } from "./sandbox-policy.js";
import { createSandboxRunner } from "./sandbox-runner.js";
import fixturePlan from "./fixture-plan.json" with { type: "json" };

export type RunSource = "fixture" | "workspace";
export type ServerMode = RunSource;

/** Validated request handed to the run executor. */
export type RunTask = {
  runId: string;
  source: RunSource;
  /** Absolute, allowlisted repository path; workspace runs only. */
  repoPath?: string;
  providerId?: string;
};

/** `createRunReport` output as returned over HTTP, tagged with its data source. */
export type RunResponse = RunReport & { source: RunSource };

export type RunExecutor = (task: RunTask) => Promise<RunReport>;

/** Stage seam for workspace runs: real modules by default, injectable for tests. */
export type WorkspacePipeline = {
  provider: string;
  model: string;
  review(repoPath: string): Promise<ReviewInput>;
  diffs(repoPath: string, review: ReviewInput): Promise<FileDiff[]>;
  plan(input: PlannerInput): Promise<AnalysisPlan>;
  sandbox(mode: SandboxMode, plan: AnalysisPlan): Promise<ExecutionResult[]>;
};

export type WorkspacePipelineFactory = (
  task: RunTask,
) => Promise<WorkspacePipeline> | WorkspacePipeline;

export type RejectionReason =
  | "invalid_request"
  | "unsupported_source"
  | "invalid_repo_path"
  | "run_in_progress"
  | "workspace_unavailable"
  | "run_failed";

/** Closed union: log records can only carry non-sensitive metadata. */
export type RunLogRecord =
  | { event: "request"; method: string; route: string; statusCode: number }
  | { event: "run.accepted"; runId: string; source: RunSource }
  | {
      event: "run.finished";
      runId: string;
      source: RunSource;
      statusCode: number;
      durationMs: number;
    }
  | { event: "run.rejected"; reason: RejectionReason }
  | { event: "request.rejected"; reason: "client_error"; statusCode: number };

export type BuildServerOptions = {
  /** Server mode. `workspace` (default) also accepts fixture requests. */
  mode?: ServerMode;
  /** Allowlist root every workspace repository path must resolve inside. */
  rootDir?: string;
  /** Full run executor override (tests, embedders). Defaults to the real pipeline. */
  executeRun?: RunExecutor;
  /** Workspace stage override; only consulted when the default executor runs. */
  createWorkspacePipeline?: WorkspacePipelineFactory;
  /** Safe metadata sink. Defaults to a no-op so nothing leaks without an opt-in. */
  log?: (record: RunLogRecord) => void;
};

/** Raised when workspace execution is requested without the required runtime config. */
export class WorkspaceUnavailableError extends Error {
  constructor() {
    super("workspace analysis unavailable");
    this.name = "WorkspaceUnavailableError";
  }
}

const INVALID_REQUEST = { error: "invalid request" } as const;
const INVALID_REPO_PATH = { error: "invalid repository path" } as const;
const RUN_IN_PROGRESS = { error: "run already in progress" } as const;
const RUN_NOT_FOUND = { error: "run not found" } as const;
const NOT_FOUND = { error: "not found" } as const;
const RUN_FAILED = { error: "run failed" } as const;
const WORKSPACE_UNAVAILABLE = { error: "workspace analysis unavailable" } as const;

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_BODY_KEYS = new Set(["source", "repoPath", "providerId"]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_REPO_PATH_LENGTH = 512;
const MAX_PARAM_LENGTH = 256;
const MAX_STORED_RUNS = 64;
const BODY_LIMIT_BYTES = 65_536;
const DURATION_KEYS = [
  "totalMs",
  "ocrMs",
  "planningMs",
  "vulnerableMs",
  "patchedMs",
] as const satisfies readonly (keyof ReportDurations)[];

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
// Both `src/` and `dist/` sit three levels below the repository root.
const DEFAULT_ROOT_DIR = resolve(moduleDirectory, "..", "..", "..");

const invalidFixture = (): never => {
  throw new Error("fixture plan rejected");
};

type FixtureReplay = {
  provider: string;
  model: string;
  reviewedFiles: string[];
  hypotheses: AnalysisPlan["hypotheses"];
  vulnerableResults: ExecutionResult[];
  patchedResults: ExecutionResult[];
  durations: ReportDurations;
};

const readDurations = (value: unknown): ReportDurations => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidFixture();
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== DURATION_KEYS.length) return invalidFixture();
  const durations = {} as ReportDurations;
  for (const key of DURATION_KEYS) {
    const duration = record[key];
    if (typeof duration !== "number" || !Number.isSafeInteger(duration)) {
      return invalidFixture();
    }
    if (duration < 0) return invalidFixture();
    durations[key] = duration;
  }
  return durations;
};

const parseFixturePlan = (value: unknown): FixtureReplay => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidFixture();
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return invalidFixture();
  const { provider, model, reviewedFiles } = record;
  if (typeof provider !== "string" || typeof model !== "string") {
    return invalidFixture();
  }
  if (
    !Array.isArray(reviewedFiles) ||
    !reviewedFiles.every((entry) => typeof entry === "string")
  ) {
    return invalidFixture();
  }
  return {
    provider,
    model,
    reviewedFiles: [...reviewedFiles],
    hypotheses: analysisPlanSchema.parse({
      version: 1,
      hypotheses: record.hypotheses,
    }).hypotheses,
    vulnerableResults: executionResultSchema
      .array()
      .parse(record.vulnerableResults),
    patchedResults: executionResultSchema.array().parse(record.patchedResults),
    durations: readDurations(record.durations),
  };
};

const FIXTURE_REPLAY = parseFixturePlan(fixturePlan);

/**
 * Replays the recorded fixture run. Pure data: no LLM call, no container, no network,
 * and the same verdicts on every execution.
 */
const replayFixtureRun = (runId: string): RunReport =>
  createRunReport({
    runId,
    provider: FIXTURE_REPLAY.provider,
    model: FIXTURE_REPLAY.model,
    reviewedFiles: FIXTURE_REPLAY.reviewedFiles,
    hypotheses: FIXTURE_REPLAY.hypotheses,
    vulnerableResults: FIXTURE_REPLAY.vulnerableResults,
    patchedResults: FIXTURE_REPLAY.patchedResults,
    durations: FIXTURE_REPLAY.durations,
  });

const createDefaultWorkspacePipeline: WorkspacePipelineFactory = (task) => {
  const baseUrl = process.env.TRUSTGATE_LLM_BASE_URL;
  const model = process.env.TRUSTGATE_LLM_MODEL;
  const image = process.env.TRUSTGATE_SANDBOX_IMAGE;
  if (baseUrl === undefined || model === undefined || image === undefined) {
    throw new WorkspaceUnavailableError();
  }
  const providerId =
    task.providerId ?? process.env.TRUSTGATE_PROVIDER_ID ?? "default";
  const apiKeyEnv = process.env.TRUSTGATE_LLM_API_KEY_ENV;
  const kind =
    process.env.TRUSTGATE_LLM_KIND === "anthropic-compatible"
      ? "anthropic-compatible"
      : "openai-compatible";
  const client = createLlmClient({
    id: providerId,
    kind,
    baseUrl,
    model,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
  });
  const planner = createSecurityPlanner(client);
  const ocr = createOcrAdapter();
  const sandbox = createSandboxRunner({
    image,
    hostRuntime: {
      home: process.env.HOME ?? homedir(),
      xdgRuntimeDir:
        process.env.XDG_RUNTIME_DIR ?? join(homedir(), ".cache", "trustgate"),
    },
  });

  return {
    provider: client.id,
    model: client.model,
    review: (repoPath) => ocr.collect(repoPath),
    diffs: (repoPath, review) => collectDiffs(repoPath, review.files),
    plan: (input) => planner.plan(input),
    sandbox: (mode, plan) => sandbox.run(mode, plan),
  };
};

export const createDefaultExecutor = (
  createWorkspacePipeline: WorkspacePipelineFactory = createDefaultWorkspacePipeline,
): RunExecutor => {
  return async (task) => {
    if (task.source === "fixture") return replayFixtureRun(task.runId);

    const repoPath = task.repoPath;
    if (repoPath === undefined) throw new WorkspaceUnavailableError();
    const pipeline = await createWorkspacePipeline(task);

    const ocrStartedAt = Date.now();
    const review = await pipeline.review(repoPath);
    const diffs = await pipeline.diffs(repoPath, review);
    const ocrMs = Date.now() - ocrStartedAt;

    const planningStartedAt = Date.now();
    const plan = await pipeline.plan({ ...review, diffs });
    const planningMs = Date.now() - planningStartedAt;

    const vulnerableStartedAt = Date.now();
    const vulnerableResults = await pipeline.sandbox("vulnerable", plan);
    const vulnerableMs = Date.now() - vulnerableStartedAt;

    const patchedStartedAt = Date.now();
    const patchedResults = await pipeline.sandbox("patched", plan);
    const patchedMs = Date.now() - patchedStartedAt;

    return createRunReport({
      runId: task.runId,
      provider: pipeline.provider,
      model: pipeline.model,
      reviewedFiles: review.files.map((file) => file.path),
      hypotheses: plan.hypotheses,
      vulnerableResults,
      patchedResults,
      durations: {
        totalMs: ocrMs + planningMs + vulnerableMs + patchedMs,
        ocrMs,
        planningMs,
        vulnerableMs,
        patchedMs,
      },
    });
  };
};

type ParsedRunBody =
  | { ok: true; task: Omit<RunTask, "runId"> }
  | { ok: false; reason: RejectionReason };

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const isRepoPathInput = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_REPO_PATH_LENGTH &&
  !CONTROL_CHARACTER_PATTERN.test(value);

const parseRunBody = (body: unknown, mode: ServerMode): ParsedRunBody => {
  if (!isPlainRecord(body)) return { ok: false, reason: "invalid_request" };
  const keys = Object.keys(body);
  if (keys.length === 0) return { ok: false, reason: "invalid_request" };
  for (const key of keys) {
    if (!RUN_BODY_KEYS.has(key)) return { ok: false, reason: "invalid_request" };
  }
  const { source, repoPath, providerId } = body;
  if (source !== "fixture" && source !== "workspace") {
    return { ok: false, reason: "invalid_request" };
  }
  if (mode === "fixture" && source !== "fixture") {
    return { ok: false, reason: "unsupported_source" };
  }
  if (repoPath !== undefined && !isRepoPathInput(repoPath)) {
    return { ok: false, reason: "invalid_request" };
  }
  if (
    providerId !== undefined &&
    !(typeof providerId === "string" && PROVIDER_ID_PATTERN.test(providerId))
  ) {
    return { ok: false, reason: "invalid_request" };
  }
  return {
    ok: true,
    task: {
      source,
      ...(repoPath === undefined ? {} : { repoPath }),
      ...(providerId === undefined ? {} : { providerId }),
    },
  };
};

const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Identity of the allowlist root, captured once when the server is built. Path checks compare
 * against this instead of a freshly resolved `rootDir`: replacing the root itself (a symlink in
 * its place, or a new directory at the same path) would otherwise silently redefine the
 * allowlist.
 */
export type RootIdentity = {
  /** Canonical path of the pinned root; stays the baseline for every containment check. */
  readonly realPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
};

/** Pins the allowlist root; `undefined` when it is not an existing directory. */
const pinRootIdentity = (rootDir: string): RootIdentity | undefined => {
  try {
    const realPath = realpathSync(rootDir);
    const stats = statSync(realPath, { bigint: true });
    if (!stats.isDirectory()) return undefined;
    return { realPath, dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
};

/**
 * True while `rootDir` still names the directory that was pinned. A swapped-in symlink resolves
 * somewhere else, and a recreated directory at the same path has a different device/inode pair.
 */
const rootStillPinned = async (
  rootDir: string,
  identity: RootIdentity,
): Promise<boolean> => {
  try {
    if ((await realpath(rootDir)) !== identity.realPath) return false;
    const stats = await stat(identity.realPath, { bigint: true });
    return stats.isDirectory() && stats.dev === identity.dev && stats.ino === identity.ino;
  } catch {
    return false;
  }
};

type ResolvedRepoPath = { ok: true; path: string } | { ok: false };

const hasTraversalSegment = (candidate: string): boolean =>
  candidate.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..");

/**
 * Real-path containment check against the pinned root: the root must still match its identity,
 * `target` must exist, resolve (symlinks included) inside that root, and stay a directory.
 * An unpinned root admits nothing, so a root that cannot be resolved fails closed.
 */
const resolveRealPathInsideRoot = async (
  rootDir: string,
  identity: RootIdentity | undefined,
  target: string,
): Promise<string | undefined> => {
  if (identity === undefined) return undefined;
  try {
    if (!(await rootStillPinned(rootDir, identity))) return undefined;
    if (!isInside(identity.realPath, target)) return undefined;
    const resolved = await realpath(target);
    if (!isInside(identity.realPath, resolved)) return undefined;
    if (!(await stat(resolved)).isDirectory()) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
};

/** Raised when an accepted repository path stops resolving inside the root before execution. */
export class InvalidRepoPathError extends Error {
  constructor() {
    super("repository path is no longer allowed");
    this.name = "InvalidRepoPathError";
  }
}

/**
 * Re-validates a repository path that was already accepted, immediately before the executor
 * hands it to the pipeline (symlink swap, rename, or deletion after the request-time check).
 *
 * Residual TOCTOU window: this check and the pipeline's first filesystem call are still
 * separate operations, so a fully race-free design needs an open dirfd plus O_NOFOLLOW
 * traversal. The window narrows from "request arrival" to "pipeline creation" here.
 */
export const isRepoPathAllowedInRoot = async (
  rootDir: string,
  repoPath: string,
): Promise<boolean> =>
  (await resolveRealPathInsideRoot(rootDir, pinRootIdentity(rootDir), repoPath)) !== undefined;

/**
 * Wraps a pipeline factory with the pre-execution re-validation above. Pass the identity pinned
 * when the server was built so both checks share one baseline; without it the root is pinned
 * freshly on every call.
 */
export const createReverifiedPipelineFactory = (
  rootDir: string,
  createWorkspacePipeline: WorkspacePipelineFactory,
  identity?: RootIdentity,
): WorkspacePipelineFactory =>
  async function reverifiedPipelineFactory(task) {
    if (task.source === "workspace" && task.repoPath !== undefined) {
      const pinned = identity ?? pinRootIdentity(rootDir);
      if ((await resolveRealPathInsideRoot(rootDir, pinned, task.repoPath)) === undefined) {
        throw new InvalidRepoPathError();
      }
    }
    return createWorkspacePipeline(task);
  };

/**
 * Normalizes a repo-relative path into the allowlisted root: absolute paths, `.`/`..`
 * segments, empty segments, backslashes, and symlinks escaping the root are all
 * rejected, so a request can never point the pipeline outside of `rootDir`.
 */
const resolveWorkspaceRepoPath = async (
  rootDir: string,
  identity: RootIdentity | undefined,
  candidate: string | undefined,
): Promise<ResolvedRepoPath> => {
  if (candidate !== undefined) {
    if (isAbsolute(candidate) || candidate.includes("\\")) return { ok: false };
    if (hasTraversalSegment(candidate)) return { ok: false };
  }
  if (identity === undefined) return { ok: false };
  const target =
    candidate === undefined ? identity.realPath : join(identity.realPath, candidate);
  const resolved = await resolveRealPathInsideRoot(rootDir, identity, target);
  return resolved === undefined ? { ok: false } : { ok: true, path: resolved };
};

const routeLabel = (request: FastifyRequest): string => {
  const url = request.routeOptions.url;
  return typeof url === "string" && url.length > 0 ? url : "unmatched";
};

const isUnavailable = (error: unknown): boolean =>
  error instanceof WorkspaceUnavailableError || error instanceof LlmGatewayError;

const readStatusCode = (error: unknown): number => {
  if (typeof error === "object" && error !== null) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") return statusCode;
  }
  return 500;
};

const clientErrorStatus = (error: ConnectionError): number => {
  if (error.code === "HPE_HEADER_OVERFLOW") return 431;
  if (error.code === "ERR_HTTP_REQUEST_TIMEOUT") return 408;
  return 400;
};

/** Fixed payload for parse-level failures; never carries request or framework text. */
const CLIENT_ERROR_BODY = JSON.stringify(INVALID_REQUEST);

export const buildServer = (options: BuildServerOptions = {}): FastifyInstance => {
  const mode = options.mode ?? "workspace";
  const rootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
  // The allowlist root is pinned exactly once, here. A root that is later replaced by a symlink
  // (or by a fresh directory at the same path) no longer matches its identity, and every path
  // check below refuses it. A root that cannot be pinned admits nothing at all: failing closed
  // keeps a mistyped or missing root from being redefined by whoever controls its parent.
  const rootIdentity = pinRootIdentity(rootDir);
  // The one place this server hands records to a log sink: wrap the caller's sink once, here, so
  // no code path — present or future — can write an unredacted record to it.
  const log = options.log === undefined ? undefined : createRedactingSink(options.log);
  const createWorkspacePipeline =
    options.createWorkspacePipeline ?? createDefaultWorkspacePipeline;
  const executeRun =
    options.executeRun ??
    createDefaultExecutor(
      // The default executor re-validates the accepted path, against the same pinned root,
      // right before the pipeline runs.
      createReverifiedPipelineFactory(rootDir, createWorkspacePipeline, rootIdentity),
    );

  const runs = new Map<string, RunResponse>();
  let inFlight = false;

  const rememberRun = (run: RunResponse): void => {
    if (runs.size >= MAX_STORED_RUNS) {
      const oldest = runs.keys().next();
      if (!oldest.done) runs.delete(oldest.value);
    }
    runs.set(run.runId, run);
  };

  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT_BYTES,
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
    // Parse-level failures (oversized headers, bad request lines) never reach the router, so
    // Fastify's default handler answers with framework internals ("Exceeded maximum allowed HTTP
    // header size", "Client Error") and the raw request text. Answer with a fixed body instead
    // and keep the record to non-sensitive metadata.
    clientErrorHandler: (error: ConnectionError, socket: Socket) => {
      const statusCode = clientErrorStatus(error);
      log?.({ event: "request.rejected", reason: "client_error", statusCode });
      if (socket.destroyed || !socket.writable) {
        socket.destroy();
        return;
      }
      socket.end(
        `HTTP/1.1 ${statusCode} ${STATUS_CODES[statusCode] ?? "Error"}\r\n` +
          "content-type: application/json; charset=utf-8\r\n" +
          `content-length: ${Buffer.byteLength(CLIENT_ERROR_BODY)}\r\n` +
          "connection: close\r\n" +
          "\r\n" +
          CLIENT_ERROR_BODY,
      );
    },
    // Framework-level failures (oversized params, malformed URLs) otherwise answer with
    // the raw request path; responding generically keeps request text out of replies.
    frameworkErrors: (
      _error: FastifyError,
      _request: FastifyRequest,
      reply: unknown,
    ) => {
      const minimalReply = reply as {
        status(code: number): { send(payload: unknown): unknown };
      };
      minimalReply.status(400).send(INVALID_REQUEST);
    },
  });

  // Fastify's default handlers echo request-derived text (route paths, parser details);
  // both are replaced with fixed strings so nothing request-shaped reaches the client.
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = readStatusCode(error);
    if (statusCode >= 400 && statusCode < 500) {
      return reply.status(400).send(INVALID_REQUEST);
    }
    return reply.status(500).send(RUN_FAILED);
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(NOT_FOUND),
  );
  app.addHook("onResponse", async (request, reply) => {
    log?.({
      event: "request",
      method: request.method,
      route: routeLabel(request),
      statusCode: reply.statusCode,
    });
  });

  app.get("/health", async () => ({ ok: true }));

  app.post("/api/runs", async (request, reply) => {
    const parsed = parseRunBody(request.body, mode);
    if (!parsed.ok) {
      log?.({ event: "run.rejected", reason: parsed.reason });
      return reply.status(400).send(INVALID_REQUEST);
    }
    // The gate is checked and claimed in one synchronous block, before any await: workspace
    // requests resolve their path asynchronously, and a claim made after that await lets two
    // concurrent requests run in parallel. Body parsing stays ahead of the gate so malformed
    // bodies are still 400 while a run is in flight.
    if (inFlight) {
      log?.({ event: "run.rejected", reason: "run_in_progress" });
      return reply.status(409).send(RUN_IN_PROGRESS);
    }
    inFlight = true;

    const runId = `run-${randomUUID()}`;
    const startedAt = Date.now();
    try {
      let repoPath: string | undefined;
      if (parsed.task.source === "workspace") {
        const resolved = await resolveWorkspaceRepoPath(
          rootDir,
          rootIdentity,
          parsed.task.repoPath,
        );
        if (!resolved.ok) {
          log?.({ event: "run.rejected", reason: "invalid_repo_path" });
          return reply.status(400).send(INVALID_REPO_PATH);
        }
        repoPath = resolved.path;
      }

      const task: RunTask = {
        runId,
        source: parsed.task.source,
        ...(repoPath === undefined ? {} : { repoPath }),
        ...(parsed.task.providerId === undefined
          ? {}
          : { providerId: parsed.task.providerId }),
      };
      log?.({ event: "run.accepted", runId, source: task.source });
      const report = await executeRun(task);
      const response: RunResponse = { ...report, source: task.source };
      rememberRun(response);
      log?.({
        event: "run.finished",
        runId: response.runId,
        source: task.source,
        statusCode: 201,
        durationMs: Date.now() - startedAt,
      });
      return reply
        .status(201)
        .header("cache-control", "no-store")
        .send(response);
    } catch (error) {
      if (error instanceof InvalidRepoPathError) {
        // The accepted path stopped resolving inside the root before the pipeline ran.
        log?.({ event: "run.rejected", reason: "invalid_repo_path" });
        return reply.status(400).send(INVALID_REPO_PATH);
      }
      if (isUnavailable(error)) {
        log?.({ event: "run.rejected", reason: "workspace_unavailable" });
        return reply.status(503).send(WORKSPACE_UNAVAILABLE);
      }
      log?.({ event: "run.rejected", reason: "run_failed" });
      return reply.status(500).send(RUN_FAILED);
    } finally {
      inFlight = false;
    }
  });

  app.get("/api/runs/:runId", async (request, reply) => {
    const params = request.params as { runId?: unknown };
    const runId = params.runId;
    if (
      typeof runId !== "string" ||
      !PUBLIC_ID_PATTERN.test(runId) ||
      !runs.has(runId)
    ) {
      return reply.status(404).send(RUN_NOT_FOUND);
    }
    return reply
      .status(200)
      .header("cache-control", "no-store")
      .send(runs.get(runId));
  });

  return app;
};
