import type { FetchLike } from "./api";

export type SkillAgent = "codex" | "claude" | "cursor" | "hermes";
export type SkillInstallResult = "installed" | "exists";

const FAILED = "스킬을 설치하지 못했습니다";
const MAX_RESPONSE_BYTES = 4096;
const browserFetch: FetchLike = (input, init) => fetch(input, init);

/** A write is confirmed only by the exact 201 contract; never reflect server error text. */
export const installSkill = async (agent: SkillAgent, fetcher: FetchLike = browserFetch): Promise<SkillInstallResult> => {
  if (!["codex", "claude", "cursor", "hermes"].includes(agent)) throw new Error(FAILED);
  let response: Response;
  try {
    response = await fetcher("/api/skills/install", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent }),
    });
  } catch { throw new Error(FAILED); }
  // A conflict means a file already exists; no overwrite or install success is implied.
  if (response.status === 409) return "exists";
  if (response.status !== 201 || response.body === null) throw new Error(FAILED);
  try {
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new Error(FAILED);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(FAILED);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const data: unknown = JSON.parse(text);
    if (typeof data !== "object" || data === null || Array.isArray(data) ||
        !("agent" in data) || data.agent !== agent ||
        !("installed" in data) || data.installed !== true) throw new Error(FAILED);
    return "installed";
  } catch { throw new Error(FAILED); }
};
