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
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
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
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import { collectDiffs, type FileDiff } from "./diff-collector.js";
import { createOcrAdapter, type ReviewInput } from "./ocr-adapter.js";
import { ExistingOAuthLoginError, localOAuthLogin, type OAuthLogin } from "./oauth-login.js";
import { createSecurityPlanner, type PlannerInput } from "./planner.js";
import { createRedactingSink } from "./redaction.js";
import {
  createSetupStore,
  parseSetupSettings,
  ProviderChangedError,
  type SetupSettings,
  type SetupStore,
} from "./setup-store.js";
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
  /** Test seam for the built-in pipeline after live settings resolution. */
  createWorkspacePipelineForSettings?: (task: RunTask, settings: SetupSettings) => Promise<WorkspacePipeline> | WorkspacePipeline;
  /** Prebuilt dashboard directory override for isolated tests; defaults to apps/web/dist. */
  dashboardDistDir?: string;
  /** Nonsecret settings store override; tests must not access the user's config. */
  setupStore?: SetupStore;
  /** Injected login runner for tests; production uses pinned local SDK. */
  oauthLogin?: OAuthLogin;
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
const SETUP_UNAVAILABLE = { error: "setup unavailable" } as const;
const CONNECTION_TEST_FAILED = { error: "connection test failed" } as const;

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
const DEFAULT_DASHBOARD_DIR = resolve(moduleDirectory, "..", "..", "web", "dist");
const ASSET_NAME = /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|png|webp|woff2?|ico)$/;
const ASSET_MIME: Record<string, string> = {
  js: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ico: "image/x-icon",
};
const DASHBOARD_UNAVAILABLE = { error: "dashboard unavailable" } as const;
const SKILL_INSTALL_UNAVAILABLE = { error: "skill install unavailable" } as const;
const SKILL_ALREADY_INSTALLED = { error: "skill already installed" } as const;
const SKILL_AGENT_DIR = { codex: ".agents", claude: ".claude", cursor: ".cursor", hermes: ".hermes" } as const;
type SkillAgent = keyof typeof SKILL_AGENT_DIR;
const INSTALLER_PATH = resolve(DEFAULT_ROOT_DIR, "bin", "trustgate.mjs");
const INSTALL_TIMEOUT_MS = 10_000;

/** Invoke only the bundled skill installer; never a shell or an agent executable. */
const runSkillInstaller = (agent: SkillAgent, root: string): Promise<boolean> =>
  new Promise((done) => {
    execFile(process.execPath, [INSTALLER_PATH, "skill", "install", "--agent", agent, "--project", root], {
      shell: false,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 4_096,
      windowsHide: true,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    }, (error) => done(error === null));
  });

const installedSkillFile = (root: string, agent: SkillAgent): string =>
  join(root, SKILL_AGENT_DIR[agent], "skills", "trustgate", "SKILL.md");
const existingSkill = async (path: string): Promise<"missing" | "installed" | "blocked"> => {
  try { await lstat(path); return "installed"; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "blocked";
  }
};

type DashboardAsset = { content: Buffer; mime: string };
/** Snapshot only prebuilt hashed assets; no request path is ever used as a filesystem path. */
const loadDashboard = (dist: string): Map<string, DashboardAsset> | undefined => {
  try {
    const assetsDir = join(dist, "assets");
    if (!lstatSync(dist).isDirectory() || !lstatSync(assetsDir).isDirectory()) return undefined;
    const readSafeFile = (path: string, maxBytes: number): Buffer => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stats = fstatSync(fd);
        if (!stats.isFile() || stats.size > maxBytes) throw new Error("invalid dashboard asset");
        return readFileSync(fd);
      } finally { closeSync(fd); }
    };
    const index = readSafeFile(join(dist, "index.html"), 1_048_576);
    const html = index.toString("utf8");
    const references = [...html.matchAll(/(?:src|href)="\/assets\/([^"/]+)"/g)].map((match) => match[1]);
    if (references.length === 0 || references.some((name) => name === undefined || !ASSET_NAME.test(name))) return undefined;
    const assets = new Map<string, DashboardAsset>([["/", { content: index, mime: "text/html; charset=utf-8" }]]);
    for (const name of references) {
      if (name === undefined) return undefined;
      const extension = name.slice(name.lastIndexOf(".") + 1);
      const mime = ASSET_MIME[extension];
      if (mime === undefined) return undefined;
      assets.set(`/assets/${name}`, { content: readSafeFile(join(assetsDir, name), 16_777_216), mime });
    }
    // Vite emits font/image URLs inside CSS, not in index.html. Snapshot only those
    // validated, prebuilt files too; never resolve a path supplied by an HTTP request.
    const cssReferences = references.filter((name) => name?.endsWith(".css"));
    const embedded = new Set<string>();
    for (const name of cssReferences) {
      const css = assets.get(`/assets/${name}`)?.content.toString("utf8") ?? "";
      for (const match of css.matchAll(/url\(\s*['"]?\/assets\/([^'"\s)]+)['"]?\s*\)/g)) {
        const assetName = match[1];
        if (assetName === undefined || !ASSET_NAME.test(assetName)) return undefined;
        const extension = assetName.slice(assetName.lastIndexOf(".") + 1);
        if (extension === "js" || extension === "css") return undefined;
        embedded.add(assetName);
        if (embedded.size > 128) return undefined;
      }
    }
    for (const name of embedded) {
      const extension = name.slice(name.lastIndexOf(".") + 1);
      const mime = ASSET_MIME[extension];
      if (mime === undefined) return undefined;
      assets.set(`/assets/${name}`, { content: readSafeFile(join(assetsDir, name), 16_777_216), mime });
    }
    return assets;
  } catch {
    // Missing, corrupt, or swapped build artifacts fail closed without disclosing paths.
    return undefined;
  }
};

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

const environmentSettings = (): SetupSettings | null => {
  const baseUrl = process.env.TRUSTGATE_LLM_BASE_URL;
  const model = process.env.TRUSTGATE_LLM_MODEL;
  const sandboxImage = process.env.TRUSTGATE_SANDBOX_IMAGE;
  if (baseUrl === undefined || model === undefined || sandboxImage === undefined) return null;
  return parseSetupSettings({
    kind: process.env.TRUSTGATE_LLM_KIND ?? "openai-compatible",
    baseUrl,
    model,
    apiKeyEnv: process.env.TRUSTGATE_LLM_API_KEY_ENV ?? "",
    sandboxImage,
  });
};

const createDefaultWorkspacePipeline = (settings: SetupSettings, secret: string | null): WorkspacePipelineFactory => (task) => {
  const providerId =
    task.providerId ?? process.env.TRUSTGATE_PROVIDER_ID ?? "default";
  const client = createLlmClient(settings.kind === "openai-codex-oauth"
    ? { id: providerId, kind: settings.kind, model: settings.model }
    : { id: providerId, kind: settings.kind, baseUrl: settings.baseUrl, model: settings.model,
        ...(settings.apiKeyEnv === "" ? (secret ? { headers: settings.kind === "openai-compatible" ? { authorization: `Bearer ${secret}` } : { "x-api-key": secret } } : {}) : { apiKeyEnv: settings.apiKeyEnv }) });
  const planner = createSecurityPlanner(client);
  const ocr = createOcrAdapter();
  const sandbox = createSandboxRunner({
    image: settings.sandboxImage,
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
  createWorkspacePipeline: WorkspacePipelineFactory = async (task) => {
    let settings: SetupSettings | null;
    try { settings = (await createSetupStore().read()) ?? environmentSettings(); }
    catch { throw new WorkspaceUnavailableError(); }
    if (settings === null) throw new WorkspaceUnavailableError();
    return createDefaultWorkspacePipeline(settings, await createSetupStore().readCredential(settings))(task);
  },
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

const localRequest = (request: FastifyRequest, writing: boolean): boolean => {
  const host = request.headers.host;
  if (typeof host !== "string" ||
      !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[1-9]\d{0,4})?$/.test(host) ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip)) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return !writing;
  return origin === "http://127.0.0.1:5173" ||
    origin === "http://localhost:5173" || origin === `http://${host}`;
};

export const buildServer = (options: BuildServerOptions = {}): FastifyInstance => {
  const mode = options.mode ?? "workspace";
  const rootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
  // The allowlist root is pinned exactly once, here. A root that is later replaced by a symlink
  // (or by a fresh directory at the same path) no longer matches its identity, and every path
  // check below refuses it. A root that cannot be pinned admits nothing at all: failing closed
  // keeps a mistyped or missing root from being redefined by whoever controls its parent.
  const rootIdentity = pinRootIdentity(rootDir);
  const dashboard = loadDashboard(options.dashboardDistDir ?? DEFAULT_DASHBOARD_DIR);
  // The one place this server hands records to a log sink: wrap the caller's sink once, here, so
  // no code path — present or future — can write an unredacted record to it.
  const log = options.log === undefined ? undefined : createRedactingSink(options.log);
  // Resolve the default path at request time, so a malformed XDG environment fails closed
  // through the fixed API error rather than crashing the server during startup.
  const setupStore: SetupStore = options.setupStore ?? {
    read: () => createSetupStore().read(),
    save: (value) => createSetupStore().save(value),
    readCredential: (settings) => createSetupStore().readCredential(settings),
    saveCredential: (secret, provider) => createSetupStore().saveCredential(secret, provider),
  };
  const effectiveSettings = async (): Promise<SetupSettings | null> =>
    (await setupStore.read()) ?? environmentSettings();
  const createWorkspacePipeline: WorkspacePipelineFactory =
    options.createWorkspacePipeline ?? (async (task) => {
      let settings: SetupSettings | null;
      try { settings = await effectiveSettings(); }
      catch { throw new WorkspaceUnavailableError(); }
      if (settings === null) throw new WorkspaceUnavailableError();
      return options.createWorkspacePipelineForSettings === undefined
        ? createDefaultWorkspacePipeline(settings, await setupStore.readCredential(settings))(task)
        : options.createWorkspacePipelineForSettings(task, settings);
    });
  const executeRun =
    options.executeRun ??
    createDefaultExecutor(
      // The default executor re-validates the accepted path, against the same pinned root,
      // right before the pipeline runs.
      createReverifiedPipelineFactory(rootDir, createWorkspacePipeline, rootIdentity),
    );

  const runs = new Map<string, RunResponse>();
  const installsInFlight = new Set<SkillAgent>();
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

  const serveDashboard = (key: string, request: FastifyRequest, reply: FastifyReply) => {
    if (!localRequest(request, false)) return reply.status(403).send(INVALID_REQUEST);
    if (dashboard === undefined) return reply.status(503).send(DASHBOARD_UNAVAILABLE);
    const asset = dashboard.get(key);
    if (asset === undefined) return reply.status(404).send(NOT_FOUND);
    return reply.header("x-content-type-options", "nosniff")
      .header("content-type", asset.mime).send(asset.content);
  };
  app.get("/", async (request, reply) => serveDashboard("/", request, reply));
  app.get("/index.html", async (request, reply) => serveDashboard("/", request, reply));
  app.get("/assets/:name", async (request, reply) => {
    const name = (request.params as { name: string }).name;
    if (!ASSET_NAME.test(name)) return reply.status(404).send(NOT_FOUND);
    return serveDashboard(`/assets/${name}`, request, reply);
  });

  // Guard the resolved setup routes, not the raw URL: Fastify also routes encoded aliases.
  // Apply before parsing/handlers so rejected writes cannot save or call a provider.
  const guardSetup = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header("cache-control", "no-store");
    if (!localRequest(request, request.method !== "GET")) {
      reply.status(403).send(INVALID_REQUEST);
    }
  };

  let oauthState: "idle" | "pending" | "ready" | "error" | "existing" = "idle";
  let oauthController: AbortController | undefined;
  const login = options.oauthLogin ?? localOAuthLogin;
  const emptyBody = (body: unknown) => body === undefined ||
    (isPlainRecord(body) && Object.keys(body).length === 0);
  const authorizationUrl = (message: string): string | undefined => {
    const prefix = "OpenAI OAuth login URL: ";
    if (!message.startsWith(prefix)) return undefined;
    const candidate = message.slice(prefix.length);
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" || url.hostname !== "auth.openai.com" ||
          url.pathname !== "/oauth/authorize" || url.username || url.password || url.hash) return undefined;
      return candidate;
    } catch { return undefined; }
  };
  app.get("/api/setup/oauth/status", { onRequest: guardSetup }, async () => ({ state: oauthState }));
  app.post("/api/setup/oauth/cancel", { onRequest: guardSetup }, async (request, reply) => {
    if (!emptyBody(request.body)) return reply.status(400).send(INVALID_REQUEST);
    oauthController?.abort();
    oauthController = undefined;
    oauthState = "idle";
    return { state: oauthState };
  });
  app.post("/api/setup/oauth/start", { onRequest: guardSetup }, async (request, reply) => {
    if (!emptyBody(request.body)) return reply.status(400).send(INVALID_REQUEST);
    if (oauthState === "pending") return reply.status(409).send({ error: "login already in progress" });
    oauthState = "pending";
    const controller = new AbortController();
    oauthController = controller;
    let resolveUrl!: (url: string | undefined) => void;
    const urlPromise = new Promise<string | undefined>((resolve) => { resolveUrl = resolve; });
    let validUrlSeen = false;
    const timer = setTimeout(() => controller.abort(), 300_000);
    void login({ signal: controller.signal, onMessage: (message) => {
      const url = authorizationUrl(message);
      if (url && oauthController === controller) { validUrlSeen = true; resolveUrl(url); }
    } }).then(() => {
      if (oauthController === controller) oauthState = validUrlSeen && !controller.signal.aborted ? "ready" : "error";
    }).catch((error: unknown) => {
      if (oauthController === controller) oauthState = error instanceof ExistingOAuthLoginError ? "existing" : "error";
    }).finally(() => {
      clearTimeout(timer);
      resolveUrl(undefined);
      if (oauthController === controller) oauthController = undefined;
    });
    let urlTimer: ReturnType<typeof setTimeout> | undefined;
    const url = await Promise.race([urlPromise, new Promise<undefined>((resolve) => {
      urlTimer = setTimeout(() => resolve(undefined), 15_000);
    })]);
    if (urlTimer !== undefined) clearTimeout(urlTimer);
    if (url && oauthController === controller && !controller.signal.aborted) return { url };
    if ((oauthState as string) === "existing") return reply.status(409).send({ state: "existing" });
    if (oauthController === controller) {
      controller.abort();
      oauthController = undefined;
      oauthState = "error";
    }
    return reply.status(503).send(SETUP_UNAVAILABLE);
  });
  app.addHook("onClose", async () => { oauthController?.abort(); });

  const setupStatus = async (settings: SetupSettings | null) => ({
    mode,
    configured: settings !== null,
    settings: settings === null ? null : {
      kind: settings.kind,
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKeyEnv: settings.apiKeyEnv,
      sandboxImage: settings.sandboxImage,
      keyAvailable: settings.kind !== "openai-codex-oauth" &&
        (settings.apiKeyEnv === "" ? (await setupStore.readCredential(settings)) !== null : Boolean(process.env[settings.apiKeyEnv])),
    },
  });

  app.get("/api/setup", { onRequest: guardSetup }, async (_request, reply) => {
    try { return await setupStatus(await effectiveSettings()); }
    catch { return reply.status(503).send(SETUP_UNAVAILABLE); }
  });

  app.post("/api/setup", { onRequest: guardSetup }, async (request, reply) => {
    let settings: SetupSettings;
    try { settings = parseSetupSettings(request.body); }
    catch { return reply.status(400).send(INVALID_REQUEST); }
    try {
      await setupStore.save(settings);
      return await setupStatus(settings);
    } catch { return reply.status(503).send(SETUP_UNAVAILABLE); }
  });

  app.post("/api/setup/credential", { onRequest: guardSetup }, async (request, reply) => {
    if (!isPlainRecord(request.body) || Object.keys(request.body).length !== 3 ||
        !Object.hasOwn(request.body, "secret") || !Object.hasOwn(request.body, "kind") ||
        !Object.hasOwn(request.body, "baseUrl") ||
        typeof request.body.secret !== "string" || typeof request.body.baseUrl !== "string" ||
        (request.body.kind !== "openai-compatible" && request.body.kind !== "anthropic-compatible"))
      return reply.status(400).send(INVALID_REQUEST);
    if (request.body.secret.length === 0 || Buffer.byteLength(request.body.secret) > 4096 ||
        /[\x00-\x1f\x7f]/.test(request.body.secret) || request.body.secret.trim() !== request.body.secret)
      return reply.status(400).send(INVALID_REQUEST);
    try {
      const settings = await setupStore.read();
      if (settings === null || settings.kind === "openai-codex-oauth" || settings.apiKeyEnv !== "" ||
          settings.kind !== request.body.kind || settings.baseUrl !== request.body.baseUrl)
        return reply.status(409).send(INVALID_REQUEST);
      await setupStore.saveCredential(request.body.secret, { kind: request.body.kind, baseUrl: request.body.baseUrl });
      return { stored: true };
    }
    catch (error) { return reply.status(error instanceof ProviderChangedError ? 409 : 503).send(
      error instanceof ProviderChangedError ? INVALID_REQUEST : SETUP_UNAVAILABLE); }
  });

  app.post("/api/setup/test", { onRequest: guardSetup }, async (request, reply) => {
    if (request.body !== undefined &&
        (!isPlainRecord(request.body) || Object.keys(request.body).length !== 0)) {
      return reply.status(400).send(INVALID_REQUEST);
    }
    try {
      const settings = await effectiveSettings();
      if (settings === null) return reply.status(503).send(CONNECTION_TEST_FAILED);
      const secret = await setupStore.readCredential(settings);
      const client = createLlmClient(settings.kind === "openai-codex-oauth"
        ? { id: "setup-test", kind: settings.kind, model: settings.model, timeoutMs: 10_000 }
        : { id: "setup-test", kind: settings.kind, baseUrl: settings.baseUrl,
            model: settings.model, timeoutMs: 10_000,
            ...(settings.apiKeyEnv === "" ? (secret ? { headers: settings.kind === "openai-compatible" ? { authorization: `Bearer ${secret}` } : { "x-api-key": secret } } : {}) : { apiKeyEnv: settings.apiKeyEnv }) });
      await client.generate({ messages: [{ role: "user", content: "ping" }], maxTokens: 8 });
      return { ok: true };
    } catch { return reply.status(503).send(CONNECTION_TEST_FAILED); }
  });

  app.post("/api/skills/install", { onRequest: guardSetup }, async (request, reply) => {
    if (!isPlainRecord(request.body) || Object.keys(request.body).length !== 1 ||
        !Object.hasOwn(request.body, "agent") ||
        typeof request.body.agent !== "string" ||
        !Object.hasOwn(SKILL_AGENT_DIR, request.body.agent)) {
      return reply.status(400).send(INVALID_REQUEST);
    }
    const agent = request.body.agent as SkillAgent;
    // Only the operator-provided root may be used, never a browser-selected project.
    if (mode !== "workspace" || options.rootDir === undefined || !isAbsolute(options.rootDir) ||
        rootIdentity === undefined ||
        !(await rootStillPinned(rootDir, rootIdentity))) {
      return reply.status(403).send(SKILL_INSTALL_UNAVAILABLE);
    }
    if (installsInFlight.has(agent)) return reply.status(409).send(SKILL_ALREADY_INSTALLED);
    installsInFlight.add(agent);
    try {
      const target = installedSkillFile(rootIdentity.realPath, agent);
      const status = await existingSkill(target);
      if (status === "installed") return reply.status(409).send(SKILL_ALREADY_INSTALLED);
      if (status === "blocked") return reply.status(503).send(SKILL_INSTALL_UNAVAILABLE);
      // Recheck after filesystem lookup, immediately before invoking the installer.
      if (!(await rootStillPinned(rootDir, rootIdentity))) return reply.status(403).send(SKILL_INSTALL_UNAVAILABLE);
      if (!(await runSkillInstaller(agent, rootIdentity.realPath))) {
        return reply.status(503).send(SKILL_INSTALL_UNAVAILABLE);
      }
      return reply.status(201).send({ agent, installed: true });
    } catch { return reply.status(503).send(SKILL_INSTALL_UNAVAILABLE); }
    finally { installsInFlight.delete(agent); }
  });

  // Run creation and report reads are local-only too; unlike setup writes, CLI clients
  // without an Origin are allowed, but a supplied non-local Origin is still rejected.
  const guardRun = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header("cache-control", "no-store");
    if (!localRequest(request, false)) {
      reply.status(403).send(INVALID_REQUEST);
    }
  };

  app.post("/api/runs", { onRequest: guardRun }, async (request, reply) => {
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

  app.get("/api/runs/:runId", { onRequest: guardRun }, async (request, reply) => {
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
