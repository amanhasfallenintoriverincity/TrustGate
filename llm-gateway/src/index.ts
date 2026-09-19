import {
  createOpenAIOAuthTransport,
  type OpenAIOAuthTransport,
} from "@openai-oauth/core";
import { openaiCredentials } from "@openai-oauth/local";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type LlmRequest = {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type LlmResponse = {
  providerId: string;
  model: string;
  text: string;
  finishReason?: string;
  usage?: LlmUsage;
};

export type OpenAiCompatibleConfig = {
  id: string;
  kind: "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export type AnthropicCompatibleConfig = {
  id: string;
  kind: "anthropic-compatible";
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  anthropicVersion?: string;
  timeoutMs?: number;
};

export type OpenAiCodexOAuthConfig = {
  id: string;
  kind: "openai-codex-oauth";
  model: string;
  authFilePath?: string;
  timeoutMs?: number;
};

export type LlmProviderConfig =
  | OpenAiCompatibleConfig
  | AnthropicCompatibleConfig
  | OpenAiCodexOAuthConfig;

export type CodexTransport = Pick<OpenAIOAuthTransport, "request">;

export type CreateCodexTransportOptions = {
  authFilePath?: string;
};

export type LlmGatewayDependencies = {
  fetch?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
  createCodexTransport?: (
    options: CreateCodexTransportOptions,
  ) => Promise<CodexTransport> | CodexTransport;
};

export type LlmClient = {
  readonly id: string;
  readonly kind: LlmProviderConfig["kind"];
  readonly model: string;
  generate(request: LlmRequest): Promise<LlmResponse>;
};

export type LlmGatewayErrorCode =
  | "insecure_endpoint"
  | "invalid_configuration"
  | "missing_secret"
  | "invalid_model_output"
  | "upstream_error"
  | "timeout";

export class LlmGatewayError extends Error {
  readonly code: LlmGatewayErrorCode;
  readonly status?: number;

  constructor(
    code: LlmGatewayErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LlmGatewayError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4_096;
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const MAX_ERROR_DETAIL_LENGTH = 240;

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname === "::1";

const validateBaseUrl = (baseUrl: string): string => {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (cause) {
    throw new LlmGatewayError(
      "invalid_configuration",
      "LLM provider baseUrl must be a valid absolute URL.",
      { cause },
    );
  }

  if (url.username || url.password) {
    throw new LlmGatewayError(
      "invalid_configuration",
      "LLM provider URLs must not contain credentials.",
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new LlmGatewayError(
      "insecure_endpoint",
      "Remote LLM endpoints must use HTTPS; HTTP is allowed only on loopback.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LlmGatewayError(
      "invalid_configuration",
      "LLM provider baseUrl must use HTTP or HTTPS.",
    );
  }

  return stripTrailingSlashes(url.toString());
};

const joinEndpoint = (baseUrl: string, path: string): string =>
  `${stripTrailingSlashes(baseUrl)}/${path.replace(/^\/+/, "")}`;

const resolveSecret = (
  apiKeyEnv: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  if (!apiKeyEnv) return undefined;
  const value = env[apiKeyEnv];
  if (!value) {
    throw new LlmGatewayError(
      "missing_secret",
      `Required LLM credential environment variable is not set: ${apiKeyEnv}`,
    );
  }
  return value;
};

const combineSignals = (
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } => {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combined = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  return {
    signal: combined,
    dispose: () => clearTimeout(timer),
  };
};

const safeErrorDetail = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.slice(0, MAX_ERROR_DETAIL_LENGTH);
};

const readErrorDetail = async (response: Response): Promise<string | undefined> => {
  const body = await response.text();
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const object = parsed as Record<string, unknown>;
      if (typeof object.error === "object" && object.error !== null) {
        return safeErrorDetail((object.error as Record<string, unknown>).message);
      }
      return safeErrorDetail(object.message ?? object.detail);
    }
  } catch {
    return safeErrorDetail(body);
  }
  return undefined;
};

const assertOk = async (response: Response, providerId: string): Promise<void> => {
  if (response.ok) return;
  const detail = await readErrorDetail(response);
  throw new LlmGatewayError(
    "upstream_error",
    `LLM provider ${providerId} returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
    { status: response.status },
  );
};

const fetchJson = async (
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  providerId: string,
  timeoutMs: number,
  requestSignal?: AbortSignal,
): Promise<unknown> => {
  const scoped = combineSignals(requestSignal, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: scoped.signal });
    await assertOk(response, providerId);
    try {
      return await response.json();
    } catch (cause) {
      throw new LlmGatewayError(
        "invalid_model_output",
        `LLM provider ${providerId} returned invalid JSON.`,
        { cause },
      );
    }
  } catch (cause) {
    if (cause instanceof LlmGatewayError) throw cause;
    if (scoped.signal.aborted) {
      throw new LlmGatewayError("timeout", `LLM provider ${providerId} timed out.`, {
        cause,
      });
    }
    throw new LlmGatewayError(
      "upstream_error",
      `LLM provider ${providerId} request failed.`,
      { cause },
    );
  } finally {
    scoped.dispose();
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const requiredText = (value: unknown, providerId: string): string => {
  if (typeof value !== "string") {
    throw new LlmGatewayError(
      "invalid_model_output",
      `LLM provider ${providerId} response did not contain text output.`,
    );
  }
  return value;
};

const parseOpenAiResponse = (
  value: unknown,
  providerId: string,
  configuredModel: string,
): LlmResponse => {
  if (!isObject(value) || !Array.isArray(value.choices) || !isObject(value.choices[0])) {
    throw new LlmGatewayError(
      "invalid_model_output",
      `LLM provider ${providerId} returned an invalid Chat Completions response.`,
    );
  }
  const choice = value.choices[0];
  if (!isObject(choice.message)) {
    throw new LlmGatewayError(
      "invalid_model_output",
      `LLM provider ${providerId} returned an invalid assistant message.`,
    );
  }
  const usage = isObject(value.usage) ? value.usage : undefined;
  const inputTokens = usage ? readNumber(usage.prompt_tokens) : undefined;
  const outputTokens = usage ? readNumber(usage.completion_tokens) : undefined;
  const totalTokens = usage ? readNumber(usage.total_tokens) : undefined;
  return {
    providerId,
    model: typeof value.model === "string" ? value.model : configuredModel,
    text: requiredText(choice.message.content, providerId),
    ...(typeof choice.finish_reason === "string"
      ? { finishReason: choice.finish_reason }
      : {}),
    ...(usage
      ? {
          usage: {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(totalTokens !== undefined ? { totalTokens } : {}),
          },
        }
      : {}),
  };
};

const parseAnthropicResponse = (
  value: unknown,
  providerId: string,
  configuredModel: string,
): LlmResponse => {
  if (!isObject(value) || !Array.isArray(value.content)) {
    throw new LlmGatewayError(
      "invalid_model_output",
      `LLM provider ${providerId} returned an invalid Messages response.`,
    );
  }
  const text = value.content
    .filter(isObject)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("");
  const usage = isObject(value.usage) ? value.usage : undefined;
  const inputTokens = usage ? readNumber(usage.input_tokens) : undefined;
  const outputTokens = usage ? readNumber(usage.output_tokens) : undefined;
  return {
    providerId,
    model: typeof value.model === "string" ? value.model : configuredModel,
    text: requiredText(text || undefined, providerId),
    ...(typeof value.stop_reason === "string"
      ? { finishReason: value.stop_reason }
      : {}),
    ...(inputTokens !== undefined || outputTokens !== undefined
      ? {
          usage: {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(inputTokens !== undefined && outputTokens !== undefined
              ? { totalTokens: inputTokens + outputTokens }
              : {}),
          },
        }
      : {}),
  };
};

const extractCodexText = (value: Record<string, unknown>): string | undefined => {
  if (typeof value.output_text === "string") return value.output_text;
  if (!Array.isArray(value.output)) return undefined;
  return value.output
    .filter(isObject)
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter(isObject)
    .filter((content) =>
      ["output_text", "text"].includes(String(content.type)) &&
      typeof content.text === "string",
    )
    .map((content) => String(content.text))
    .join("") || undefined;
};

const parseCodexResponse = (
  value: unknown,
  providerId: string,
  configuredModel: string,
): LlmResponse => {
  if (!isObject(value)) {
    throw new LlmGatewayError(
      "invalid_model_output",
      `LLM provider ${providerId} returned an invalid Responses response.`,
    );
  }
  const usage = isObject(value.usage) ? value.usage : undefined;
  const inputTokens = usage ? readNumber(usage.input_tokens) : undefined;
  const outputTokens = usage ? readNumber(usage.output_tokens) : undefined;
  const totalTokens = usage ? readNumber(usage.total_tokens) : undefined;
  return {
    providerId,
    model: typeof value.model === "string" ? value.model : configuredModel,
    text: requiredText(extractCodexText(value), providerId),
    ...(typeof value.status === "string" ? { finishReason: value.status } : {}),
    ...(usage
      ? {
          usage: {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(totalTokens !== undefined ? { totalTokens } : {}),
          },
        }
      : {}),
  };
};

const createDefaultCodexTransport = async (
  options: CreateCodexTransportOptions,
): Promise<CodexTransport> => {
  const auth = openaiCredentials({
    ...(options.authFilePath ? { authFilePath: options.authFilePath } : {}),
  });
  return createOpenAIOAuthTransport({
    auth: () => auth.getSession(),
    responsesState: false,
  });
};

export const createLlmClient = (
  config: LlmProviderConfig,
  dependencies: LlmGatewayDependencies = {},
): LlmClient => {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const env = dependencies.env ?? process.env;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new LlmGatewayError(
      "invalid_configuration",
      "LLM provider timeoutMs must be greater than zero.",
    );
  }

  if (config.kind === "openai-compatible") {
    const baseUrl = validateBaseUrl(config.baseUrl);
    return {
      id: config.id,
      kind: config.kind,
      model: config.model,
      generate: async (request) => {
        const secret = resolveSecret(config.apiKeyEnv, env);
        const headers = new Headers(config.headers);
        headers.set("content-type", "application/json");
        if (secret) headers.set("authorization", `Bearer ${secret}`);
        const value = await fetchJson(
          fetchImpl,
          joinEndpoint(baseUrl, "chat/completions"),
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: config.model,
              messages: [
                ...(request.system
                  ? [{ role: "system", content: request.system }]
                  : []),
                ...request.messages,
              ],
              max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
              ...(request.temperature !== undefined
                ? { temperature: request.temperature }
                : {}),
              stream: false,
            }),
          },
          config.id,
          timeoutMs,
          request.signal,
        );
        return parseOpenAiResponse(value, config.id, config.model);
      },
    };
  }

  if (config.kind === "anthropic-compatible") {
    const baseUrl = validateBaseUrl(config.baseUrl);
    return {
      id: config.id,
      kind: config.kind,
      model: config.model,
      generate: async (request) => {
        const secret = resolveSecret(config.apiKeyEnv, env);
        const headers = new Headers(config.headers);
        headers.set("content-type", "application/json");
        headers.set(
          "anthropic-version",
          config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
        );
        if (secret) headers.set("x-api-key", secret);
        const value = await fetchJson(
          fetchImpl,
          joinEndpoint(baseUrl, "messages"),
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: config.model,
              ...(request.system ? { system: request.system } : {}),
              messages: request.messages,
              max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
              ...(request.temperature !== undefined
                ? { temperature: request.temperature }
                : {}),
              stream: false,
            }),
          },
          config.id,
          timeoutMs,
          request.signal,
        );
        return parseAnthropicResponse(value, config.id, config.model);
      },
    };
  }

  const createTransport =
    dependencies.createCodexTransport ?? createDefaultCodexTransport;
  let transportPromise: Promise<CodexTransport> | undefined;
  return {
    id: config.id,
    kind: config.kind,
    model: config.model,
    generate: async (request) => {
      transportPromise ??= Promise.resolve(
        createTransport({
          ...(config.authFilePath ? { authFilePath: config.authFilePath } : {}),
        }),
      );
      const transport = await transportPromise;
      const scoped = combineSignals(request.signal, timeoutMs);
      try {
        const response = await transport.request("/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: config.model,
            ...(request.system ? { instructions: request.system } : {}),
            input: request.messages,
            max_output_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
            stream: false,
          }),
          signal: scoped.signal,
        });
        await assertOk(response, config.id);
        let value: unknown;
        try {
          value = await response.json();
        } catch (cause) {
          throw new LlmGatewayError(
            "invalid_model_output",
            `LLM provider ${config.id} returned invalid JSON.`,
            { cause },
          );
        }
        return parseCodexResponse(value, config.id, config.model);
      } catch (cause) {
        if (cause instanceof LlmGatewayError) throw cause;
        if (scoped.signal.aborted) {
          throw new LlmGatewayError("timeout", `LLM provider ${config.id} timed out.`, {
            cause,
          });
        }
        throw new LlmGatewayError(
          "upstream_error",
          `LLM provider ${config.id} request failed.`,
          { cause },
        );
      } finally {
        scoped.dispose();
      }
    },
  };
};

export const parseStructuredJson = <T>(
  text: string,
  validate: (value: unknown) => value is T,
): T => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new LlmGatewayError(
      "invalid_model_output",
      "LLM output was not exact JSON.",
      { cause },
    );
  }
  if (!validate(value)) {
    throw new LlmGatewayError(
      "invalid_model_output",
      "LLM JSON output did not match the required schema.",
    );
  }
  return value;
};
