import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { buildSandboxArgs } from "./sandbox-policy.js";

type CommonSettings = { model: string; sandboxImage: string };
export type SetupSettings = CommonSettings & (
  | { kind: "openai-compatible" | "anthropic-compatible"; baseUrl: string; apiKeyEnv: string }
  | { kind: "openai-codex-oauth"; baseUrl: ""; apiKeyEnv: "" }
);

const KEYS = ["kind", "baseUrl", "model", "apiKeyEnv", "sandboxImage"] as const;
const MAX_FILE_BYTES = 4096;
const MAX_CREDENTIAL_FILE_BYTES = MAX_FILE_BYTES + 4096;
// Keep recognizable literal shapes in sync with apps/web/src/lib/setup.ts. Config is reflected by GET.
// Length and token boundaries avoid rejecting ordinary variable names, model IDs and image tags.
const CREDENTIAL_LITERAL = /(?:^|[^A-Za-z0-9])(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|(?:sk_live_[A-Za-z0-9]{24,}|sk-(?:proj|ant)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}|glpat-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}))(?![A-Za-z0-9_-])/;
const hasCredentialLiteral = (value: string): boolean => CREDENTIAL_LITERAL.test(value);
const invalid = (): never => { throw new Error("invalid setup configuration"); };

/** JSON-origin settings only; reconstruct the allowlisted fields before storing or using them. */
export const parseSetupSettings = (value: unknown): SetupSettings => {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== KEYS.length || KEYS.some((key) => !Object.hasOwn(object, key))) return invalid();
  const { kind, baseUrl, model, apiKeyEnv, sandboxImage } = object;
  if (kind !== "openai-compatible" && kind !== "anthropic-compatible" && kind !== "openai-codex-oauth") return invalid();
  if (typeof baseUrl !== "string" || typeof apiKeyEnv !== "string") return invalid();
  if (kind === "openai-codex-oauth") {
    if (baseUrl !== "" || apiKeyEnv !== "") return invalid();
  } else {
    if (baseUrl.length < 1 || baseUrl.length > 2048 || /[\\?#\s\x00-\x1f\x7f]/.test(baseUrl)) return invalid();
    let url: URL;
    try { url = new URL(baseUrl); } catch { return invalid(); }
    if (!url.hostname || url.username || url.password ||
        !(url.protocol === "https:" || url.protocol === "http:") ||
        !baseUrl.startsWith(`${url.protocol}//`) || url.href !== baseUrl) return invalid();
  }
  if (typeof model !== "string" || model.length < 1 || model.length > 128 ||
      model.trim() !== model || /[\x00-\x1f\x7f]/.test(model)) return invalid();
  if (apiKeyEnv === "" ? false :
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(apiKeyEnv)) return invalid();
  if (typeof sandboxImage !== "string") return invalid();
  // This one guard covers POST, disk reads and environment fallback before any GET can reflect fields.
  if ([baseUrl, model, apiKeyEnv, sandboxImage].some(hasCredentialLiteral)) return invalid();
  try { buildSandboxArgs(sandboxImage, "vulnerable"); } catch { return invalid(); }
  if (kind === "openai-codex-oauth") return { kind, baseUrl: "", model, apiKeyEnv: "", sandboxImage };
  return { kind, baseUrl, model, apiKeyEnv, sandboxImage };
};

export const defaultSetupPath = (): string =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "trustgate", "config.json");

export type SetupStore = {
  read(): Promise<SetupSettings | null>;
  save(value: unknown): Promise<SetupSettings>;
  readCredential(settings: SetupSettings): Promise<string | null>;
  saveCredential(secret: string, provider: { kind: SetupSettings["kind"]; baseUrl: string }): Promise<void>;
};

export class ProviderChangedError extends Error {
  constructor() { super("provider changed before credential save"); }
}

/** Reject symlink traversal at every directory component and refuse unsafe existing files. */
const secureDirectory = async (directory: string, create: boolean): Promise<boolean> => {
  if (!isAbsolute(directory)) return invalid();
  const { root } = parse(directory);
  let current = root;
  for (const part of directory.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return false;
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (!info.isDirectory() || (process.getuid !== undefined && info.uid !== process.getuid() &&
        current === directory)) return invalid();
    if (current === directory && (info.mode & 0o077) !== 0) return invalid();
  }
  return true;
};

const secureFile = async (path: string): Promise<boolean> => {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && info.uid !== process.getuid())) return invalid();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const sameProvider = (left: SetupSettings, right: SetupSettings): boolean =>
  left.kind === right.kind && left.baseUrl === right.baseUrl;

// The default server constructs a store for each call. Serialize both file writes
// across those instances so a provider change cannot interleave a key replacement.
const pendingWrites = new Map<string, Promise<void>>();
const serializeWrite = async <T>(path: string, write: () => Promise<T>): Promise<T> => {
  const prior = pendingWrites.get(path);
  const current = prior === undefined ? write() : prior.then(write, write);
  const settled = current.then(() => {}, () => {});
  pendingWrites.set(path, settled);
  try { return await current; }
  finally { if (pendingWrites.get(path) === settled) pendingWrites.delete(path); }
};

export const createSetupStore = (options: { configPath?: string } = {}): SetupStore => {
  const path = options.configPath ?? defaultSetupPath();
  if (!isAbsolute(path) || resolve(path) !== path || basename(path) !== "config.json") invalid();
  const directory = dirname(path);
  const credentialPath = join(directory, "credential");
  return {
    async readCredential(settings) {
      const savedSettings = await this.read();
      if (savedSettings === null || !sameProvider(savedSettings, settings) ||
          settings.kind === "openai-codex-oauth" || settings.apiKeyEnv !== "") return null;
      if (!(await secureDirectory(directory, false)) || !(await secureFile(credentialPath))) return null;
      const handle = await open(credentialPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > MAX_CREDENTIAL_FILE_BYTES ||
            (info.mode & 0o077) !== 0 ||
            (process.getuid !== undefined && info.uid !== process.getuid())) return invalid();
        const bytes = Buffer.alloc(MAX_CREDENTIAL_FILE_BYTES + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_CREDENTIAL_FILE_BYTES) return invalid();
        // Legacy plaintext credentials lack a provider binding and fail closed.
        let record: unknown;
        try { record = JSON.parse(bytes.toString("utf8", 0, bytesRead)); }
        catch { return null; }
        if (typeof record !== "object" || record === null || Array.isArray(record) ||
            Object.keys(record).length !== 3 ||
            !Object.hasOwn(record, "kind") || !Object.hasOwn(record, "baseUrl") ||
            !Object.hasOwn(record, "secret")) return null;
        const credential = record as { kind: unknown; baseUrl: unknown; secret: unknown };
        return credential.kind === settings.kind && credential.baseUrl === settings.baseUrl &&
          typeof credential.secret === "string" && credential.secret.length > 0 &&
          Buffer.byteLength(credential.secret) <= MAX_FILE_BYTES &&
          !/[\x00-\x1f\x7f]/.test(credential.secret) &&
          credential.secret.trim() === credential.secret ? credential.secret : null;
      } finally { await handle.close(); }
    },
    async saveCredential(secret, provider) { return serializeWrite(path, async () => {
      if (typeof secret !== "string" || secret.length === 0 || Buffer.byteLength(secret) > MAX_FILE_BYTES ||
          /[\x00-\x1f\x7f]/.test(secret) || secret.trim() !== secret) return invalid();
      const settings = await this.read();
      if (settings === null || settings.kind === "openai-codex-oauth" || settings.apiKeyEnv !== "") return invalid();
      if (settings.kind !== provider.kind || settings.baseUrl !== provider.baseUrl) throw new ProviderChangedError();
      await secureDirectory(directory, true);
      await secureFile(credentialPath);
      const temporary = join(directory, `.credential-${randomUUID()}`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        try { await handle.writeFile(JSON.stringify({ kind: settings.kind, baseUrl: settings.baseUrl, secret })); await handle.sync(); }
        finally { await handle.close(); }
        await secureDirectory(directory, true);
        await secureFile(credentialPath);
        const current = await this.read();
        if (current === null || !sameProvider(current, settings)) throw new ProviderChangedError();
        await rename(temporary, credentialPath);
      } finally { await rm(temporary, { force: true }); }
    }); },
    async read() {
      if (!(await secureDirectory(directory, false))) return null;
      if (!(await secureFile(path))) return null;
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES ||
            (info.mode & 0o077) !== 0) return invalid();
        const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_FILE_BYTES) return invalid();
        try { return parseSetupSettings(JSON.parse(bytes.toString("utf8", 0, bytesRead))); }
        catch { return invalid(); }
      } finally { await handle.close(); }
    },
    async save(value) { return serializeWrite(path, async () => {
      const settings = parseSetupSettings(value);
      await secureDirectory(directory, true);
      await secureFile(path);
      const previous = await this.read();
      if (previous === null || !sameProvider(previous, settings)) {
        // Remove the old key before the new endpoint becomes active.
        await secureFile(credentialPath);
        await rm(credentialPath, { force: true });
      }
      const temporary = join(directory, `.config-${randomUUID()}`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        try {
          await handle.writeFile(JSON.stringify(settings));
          await handle.sync();
        } finally { await handle.close(); }
        await secureDirectory(directory, true);
        await secureFile(path);
        await rename(temporary, path);
        return settings;
      } finally { await rm(temporary, { force: true }); }
    }); },
  };
};
