import type { ExecutionResult, FetchLike, JsonValue, RegressionVerdict, RunResponse, RunTest } from "./api";

export type ProviderKind = "openai-compatible" | "anthropic-compatible" | "openai-codex-oauth";
export type SetupSettings = {
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly model: string;
  /** Legacy name only; new credentials are stored separately on the server. */
  readonly apiKeyEnv: string;
  readonly sandboxImage: string;
};
export type SetupStatus = {
  readonly mode: "fixture" | "workspace";
  readonly configured: boolean;
  readonly settings: (SetupSettings & { readonly keyAvailable: boolean }) | null;
};

const BAD_RESPONSE = "설정 응답 형식이 올바르지 않습니다";
const REQUEST_FAILED = "설정 요청이 실패했습니다";
const NETWORK_FAILED = "설정 서버에 연결하지 못했습니다";
const RUN_BAD_RESPONSE = "분석 응답 형식이 올바르지 않습니다";
const RUN_FAILED = "프로젝트 분석에 실패했습니다";
const MAX_SETUP_BYTES = 16_384;
const MAX_RUN_BYTES = 1_048_576;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bounded = (v: unknown, max = 256): v is string => typeof v === "string" && v.length <= max;
const isKind = (v: unknown): v is ProviderKind => v === "openai-compatible" || v === "anthropic-compatible" || v === "openai-codex-oauth";
const validCredentialFields = (settings: SetupSettings): boolean =>
  settings.kind === "openai-codex-oauth"
    ? settings.baseUrl === "" && settings.apiKeyEnv === ""
    : settings.apiKeyEnv === "" || isEnvName(settings.apiKeyEnv);
// Keep recognizable literal shapes in sync with apps/orchestrator/src/setup-store.ts.
// Only known high-confidence shapes are excluded; ordinary env names/model IDs remain valid.
const CREDENTIAL_LITERAL = /(?:^|[^A-Za-z0-9])(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|(?:sk_live_[A-Za-z0-9]{24,}|sk-(?:proj|ant)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}|glpat-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}))(?![A-Za-z0-9_-])/;
const hasCredentialLiteral = (value: string): boolean => CREDENTIAL_LITERAL.test(value);
/** Reject recognizable credential literals even when they happen to match JS variable syntax. */
export const isEnvName = (value: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) && !hasCredentialLiteral(value);
export const isSafeSetupFields = (settings: SetupSettings): boolean =>
  ![settings.baseUrl, settings.model, settings.apiKeyEnv, settings.sandboxImage].some(hasCredentialLiteral);
export const isLoopbackBaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
};
const fixed = (text: string): Error => new Error(text);
const browserFetch: FetchLike = (input, init) => fetch(input, init);

/** The GET uses XHR so a fixture-run fetch stub cannot intercept unrelated setup discovery. */
const readSetupWithXhr: FetchLike = (input) => new Promise<Response>((resolve, reject) => {
  const request = new XMLHttpRequest();
  request.open("GET", input);
  request.setRequestHeader("cache-control", "no-store");
  let rejected = false;
  request.onprogress = () => {
    if (request.responseText.length > MAX_SETUP_BYTES) {
      rejected = true;
      request.abort();
      reject(fixed(BAD_RESPONSE));
    }
  };
  request.onload = () => {
    if (rejected) return;
    if (request.status === 204 || request.status === 205 || request.status === 304 ||
        request.responseText.length > MAX_SETUP_BYTES) {
      reject(fixed(BAD_RESPONSE));
      return;
    }
    resolve(new Response(request.responseText, { status: request.status }));
  };
  request.onerror = () => reject(fixed(NETWORK_FAILED));
  request.onabort = () => reject(fixed(NETWORK_FAILED));
  request.send();
});

const readJson = async (response: Response, limit: number, failure: string): Promise<unknown> => {
  try {
    // Bound bytes before parsing. Do not read untrusted error bodies at all.
    if (Number(response.headers.get("content-length")) > limit) throw fixed(failure);
    if (response.body === null) throw fixed(failure);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw fixed(failure);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    throw fixed(failure);
  }
};

const parseStatus = (value: unknown): SetupStatus => {
  if (!isRecord(value) || (value.mode !== "fixture" && value.mode !== "workspace") || typeof value.configured !== "boolean") {
    throw fixed(BAD_RESPONSE);
  }
  if (value.settings === null && !value.configured) {
    return { mode: value.mode, configured: false, settings: null };
  }
  const settings = value.settings;
  if (!isRecord(settings) || !isKind(settings.kind) || !bounded(settings.baseUrl, 2048) ||
      !bounded(settings.model) || !bounded(settings.apiKeyEnv, 128) ||
      !bounded(settings.sandboxImage) || !isSafeSetupFields(settings as SetupSettings) ||
      !validCredentialFields(settings as SetupSettings) ||
      typeof settings.keyAvailable !== "boolean" || !value.configured) {
    throw fixed(BAD_RESPONSE);
  }
  // Whitelist fields: unexpected properties (including secret values) never reach React state.
  return { mode: value.mode, configured: true, settings: {
    kind: settings.kind, baseUrl: settings.baseUrl, model: settings.model,
    apiKeyEnv: settings.apiKeyEnv, sandboxImage: settings.sandboxImage,
    keyAvailable: settings.keyAvailable,
  } };
};

export const getSetup = async (fetcher: FetchLike = readSetupWithXhr): Promise<SetupStatus> => {
  let response: Response;
  try { response = await fetcher("/api/setup", { method: "GET", cache: "no-store" }); }
  catch (error) { throw fixed(error instanceof Error && error.message === BAD_RESPONSE ? BAD_RESPONSE : NETWORK_FAILED); }
  if (!response.ok) throw fixed(REQUEST_FAILED);
  return parseStatus(await readJson(response, MAX_SETUP_BYTES, BAD_RESPONSE));
};

export const saveSetup = async (settings: SetupSettings, fetcher: FetchLike = browserFetch): Promise<SetupStatus> => {
  if (!isSafeSetupFields(settings) || !validCredentialFields(settings)) throw fixed(REQUEST_FAILED);
  // Build the body by enumeration, never from a spread of form state / server state.
  const body: SetupSettings = {
    kind: settings.kind, baseUrl: settings.baseUrl, model: settings.model,
    apiKeyEnv: settings.apiKeyEnv, sandboxImage: settings.sandboxImage,
  };
  let response: Response;
  try { response = await fetcher("/api/setup", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }); } catch { throw fixed(NETWORK_FAILED); }
  if (!response.ok) throw fixed(REQUEST_FAILED);
  const reported = parseStatus(await readJson(response, MAX_SETUP_BYTES, BAD_RESPONSE));
  // Verify the persisted state, not just a successful write response.
  const persisted = await getSetup(fetcher);
  if (!persisted.configured || persisted.settings === null || persisted.mode !== reported.mode ||
      persisted.settings.kind !== body.kind || persisted.settings.baseUrl !== body.baseUrl ||
      persisted.settings.model !== body.model || persisted.settings.apiKeyEnv !== body.apiKeyEnv ||
      persisted.settings.sandboxImage !== body.sandboxImage) throw fixed(REQUEST_FAILED);
  return persisted;
};

export const testSetup = async (fetcher: FetchLike = browserFetch): Promise<void> => {
  let response: Response;
  try { response = await fetcher("/api/setup/test", { method: "POST" }); }
  catch { throw fixed(NETWORK_FAILED); }
  if (!response.ok) throw fixed(REQUEST_FAILED);
  const payload = await readJson(response, MAX_SETUP_BYTES, BAD_RESPONSE);
  if (!isRecord(payload) || payload.ok !== true) throw fixed(BAD_RESPONSE);
};

/** Submit a credential only to the local server; never include it in settings or browser storage. */
export const saveCredential = async (
  secret: string, provider: Pick<SetupSettings, "kind" | "baseUrl">, fetcher: FetchLike = browserFetch,
): Promise<void> => {
  if (secret.length === 0 || secret.length > 4096 || secret.trim() !== secret) throw fixed(REQUEST_FAILED);
  if (!isKind(provider.kind) || provider.kind === "openai-codex-oauth" ||
      !bounded(provider.baseUrl, 2048) || hasCredentialLiteral(provider.baseUrl)) throw fixed(REQUEST_FAILED);
  let response: Response;
  try { response = await fetcher("/api/setup/credential", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, kind: provider.kind, baseUrl: provider.baseUrl }),
  }); } catch { throw fixed(NETWORK_FAILED); }
  if (!response.ok) throw fixed(REQUEST_FAILED);
  const payload = await readJson(response, MAX_SETUP_BYTES, BAD_RESPONSE);
  if (!isRecord(payload) || payload.stored !== true || Object.keys(payload).length !== 1) throw fixed(BAD_RESPONSE);
  const persisted = await getSetup(fetcher);
  if (!persisted.settings?.keyAvailable || persisted.settings.kind !== provider.kind ||
      persisted.settings.baseUrl !== provider.baseUrl) throw fixed(REQUEST_FAILED);
};

export type CodexLoginStatus = { readonly state: "idle" | "pending" | "ready" | "error" | "existing" };

export const startCodexLogin = async (fetcher: FetchLike = browserFetch): Promise<{ readonly url: string }> => {
  let response: Response;
  try { response = await fetcher("/api/setup/oauth/start", { method: "POST" }); }
  catch { throw fixed(NETWORK_FAILED); }
  if (response.status === 409) {
    const conflict = await readJson(response, MAX_SETUP_BYTES, BAD_RESPONSE);
    if (isRecord(conflict) && conflict.state === "existing" && Object.keys(conflict).length === 1) {
      throw fixed("기존 Codex 인증이 있습니다");
    }
  }
  if (!response.ok) throw fixed(REQUEST_FAILED);
  const payload = await readJson(response, MAX_SETUP_BYTES, BAD_RESPONSE);
  if (!isRecord(payload) || typeof payload.url !== "string") throw fixed(BAD_RESPONSE);
  let url: URL;
  try { url = new URL(payload.url); } catch { throw fixed(BAD_RESPONSE); }
  if (url.protocol !== "https:" || url.hostname !== "auth.openai.com" || url.username || url.password ||
      url.port || payload.url.length > 4096) throw fixed(BAD_RESPONSE);
  return { url: payload.url };
};

export const getCodexLoginStatus = async (fetcher: FetchLike = browserFetch): Promise<CodexLoginStatus> => {
  let response: Response;
  try { response = await fetcher("/api/setup/oauth/status", { method: "GET", cache: "no-store" }); }
  catch { throw fixed(NETWORK_FAILED); }
  if (!response.ok) throw fixed(REQUEST_FAILED);
  const payload = await readJson(response, MAX_SETUP_BYTES, BAD_RESPONSE);
  if (!isRecord(payload) || !["idle", "pending", "ready", "error", "existing"].includes(payload.state as string) ||
      Object.keys(payload).length !== 1) throw fixed(BAD_RESPONSE);
  return { state: payload.state as CodexLoginStatus["state"] };
};

export const cancelCodexLogin = async (fetcher: FetchLike = browserFetch): Promise<void> => {
  let response: Response;
  try { response = await fetcher("/api/setup/oauth/cancel", { method: "POST" }); }
  catch { throw fixed(NETWORK_FAILED); }
  if (!response.ok) throw fixed(REQUEST_FAILED);
  const payload = await readJson(response, MAX_SETUP_BYTES, BAD_RESPONSE);
  if (!isRecord(payload) || payload.state !== "idle" || Object.keys(payload).length !== 1) throw fixed(BAD_RESPONSE);
};

const isVerdict = (value: unknown): value is RegressionVerdict =>
  value === "FIXED" || value === "STILL_VULNERABLE" || value === "NOT_REPRODUCED" || value === "UNVERIFIED";
const isExecutionVerdict = (value: unknown): boolean =>
  value === "CONFIRMED" || value === "BLOCKED" || value === "UNVERIFIED" || value === "ERROR";
const valueForDisplay = (v: unknown): JsonValue => {
  try {
    const json = JSON.stringify(v);
    return json !== undefined && json.length < 4096 ? v as JsonValue : "표시할 수 없는 값입니다";
  } catch { return "표시할 수 없는 값입니다"; }
};
const clipped = (v: unknown): string => typeof v === "string" ? v.slice(0, 256) : "";
const safeResult = (v: unknown): ExecutionResult | null => {
  if (!isRecord(v) || !bounded(v.runId) || !bounded(v.hypothesisId) ||
      !isExecutionVerdict(v.verdict) || typeof v.executed !== "boolean" ||
      !Array.isArray(v.evidence) || v.evidence.length > 100) return null;
  const evidence: { kind: string; expected: JsonValue; actual: JsonValue }[] = [];
  for (const raw of v.evidence) {
    if (!isRecord(raw) || !bounded(raw.kind) || !("expected" in raw) || !("actual" in raw)) return null;
    evidence.push({ kind: clipped(raw.kind), expected: valueForDisplay(raw.expected), actual: valueForDisplay(raw.actual) });
  }
  return { runId: v.runId, hypothesisId: v.hypothesisId,
    verdict: v.verdict as ExecutionResult["verdict"], executed: v.executed, evidence };
};
const safeTest = (v: unknown): RunTest | null => {
  if (!isRecord(v) || !bounded(v.id) || !isRecord(v.request) ||
      !bounded(v.request.method) || !bounded(v.request.path) || !isVerdict(v.regressionVerdict)) return null;
  const vulnerableResult = safeResult(v.vulnerableResult);
  const patchedResult = safeResult(v.patchedResult);
  if (vulnerableResult === null || patchedResult === null) return null;
  return { id: v.id, request: { method: v.request.method, path: v.request.path,
    ...("body" in v.request ? { body: valueForDisplay(v.request.body) } : {}) },
    vulnerableResult, patchedResult, regressionVerdict: v.regressionVerdict };
};
const safeWorkspaceReport = (v: unknown): RunResponse => {
  if (!isRecord(v) || v.source !== "workspace" || !bounded(v.runId) || !bounded(v.provider) ||
      !bounded(v.model) || !isVerdict(v.regressionVerdict) ||
      !Array.isArray(v.reviewedFiles) || v.reviewedFiles.length > 100 ||
      !v.reviewedFiles.every((file: unknown) => bounded(file, 1024)) ||
      !Array.isArray(v.hypotheses) || v.hypotheses.length > 100 || !isRecord(v.durations)) throw fixed(RUN_BAD_RESPONSE);
  const d = v.durations;
  if (![d.totalMs, d.ocrMs, d.planningMs, d.vulnerableMs, d.patchedMs].every((n) => typeof n === "number" && Number.isFinite(n))) throw fixed(RUN_BAD_RESPONSE);
  const hypotheses: RunResponse["hypotheses"][number][] = [];
  for (const h of v.hypotheses) {
    if (!isRecord(h) || !bounded(h.id) || !bounded(h.title) || !bounded(h.category) ||
        !bounded(h.severity) || !isVerdict(h.regressionVerdict) || !Array.isArray(h.tests) || h.tests.length > 100) throw fixed(RUN_BAD_RESPONSE);
    const tests: RunTest[] = [];
    for (const raw of h.tests) {
      const test = safeTest(raw);
      if (test === null) throw fixed(RUN_BAD_RESPONSE);
      tests.push(test);
    }
    hypotheses.push({ id: h.id, title: h.title, category: h.category,
      severity: h.severity, regressionVerdict: h.regressionVerdict, tests });
  }
  return { runId: v.runId, provider: v.provider, model: v.model,
    reviewedFiles: v.reviewedFiles.map((f: string) => f.slice(0, 1024)), hypotheses,
    regressionVerdict: v.regressionVerdict, durations: {
      totalMs: d.totalMs as number, ocrMs: d.ocrMs as number, planningMs: d.planningMs as number,
      vulnerableMs: d.vulnerableMs as number, patchedMs: d.patchedMs as number }, source: "workspace" };
};

export const startWorkspaceRun = async (repoPath: string, fetcher: FetchLike = browserFetch): Promise<RunResponse> => {
  const path = repoPath.trim();
  if ((repoPath !== "" && path === "") || path.length > 512 || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path) ||
      (path !== "" && path.split("/").some((s) => s === "" || s === "." || s === ".."))) {
    throw fixed("허용된 저장소 상대 경로를 입력해 주세요");
  }
  let response: Response;
  try { response = await fetcher("/api/runs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(path === "" ? { source: "workspace" } : { source: "workspace", repoPath: path }),
  }); } catch { throw fixed("분석 서버에 연결하지 못했습니다"); }
  if (!response.ok) throw fixed(RUN_FAILED);
  return safeWorkspaceReport(await readJson(response, MAX_RUN_BYTES, RUN_BAD_RESPONSE));
};
