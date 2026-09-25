import { access } from "node:fs/promises";
import { resolveAuthFileCandidates } from "@openai-oauth/local/auth-file";
import { runOpenAIOAuthLogin } from "openai-oauth";

export type OAuthLogin = (options: { onMessage: (message: string) => void; signal: AbortSignal }) => Promise<void>;
export class ExistingOAuthLoginError extends Error {
  constructor() { super("existing authentication requires interactive confirmation"); }
}

/** Never replace an existing Codex login without the user's interactive CLI confirmation. */
export const localOAuthLogin: OAuthLogin = async ({ onMessage, signal }) => {
  for (const candidate of resolveAuthFileCandidates()) {
    try {
      await access(candidate);
      throw new ExistingOAuthLoginError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // The SDK owns its loopback callback and token storage. Do not inspect its return value.
  await runOpenAIOAuthLogin({ openBrowser: false, timeoutMs: 300_000, onMessage, signal });
};
