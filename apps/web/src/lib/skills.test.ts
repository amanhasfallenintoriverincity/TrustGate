import { describe, expect, it, vi } from "vitest";
import { installSkill } from "./skills";

describe("스킬 설치 API 계약", () => {
  it.each(["codex", "claude", "cursor", "hermes"] as const)("%s를 명시적 POST로 설치한다", async (agent) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ agent, installed: true }), { status: 201 }));
    await expect(installSkill(agent, fetcher)).resolves.toBe("installed");
    expect(fetcher).toHaveBeenCalledWith("/api/skills/install", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent }),
    });
  });

  it("409는 다른 에이전트 파일이나 손상된 파일을 덮지 않고 이미 존재함으로 표시한다", async () => {
    await expect(installSkill("hermes", async () => new Response("private-path", { status: 409 })))
      .resolves.toBe("exists");
  });

  it.each([200, 202, 204, 500])("%i 응답은 성공이 아니다", async (status) => {
    await expect(installSkill("codex", async () => new Response("secret", { status })))
      .rejects.toThrow("스킬을 설치하지 못했습니다");
  });

  it("201도 정확한 에이전트와 설치 true가 없거나 형식이 깨지면 거부한다", async () => {
    for (const body of ["broken", '{"agent":"claude","installed":true}', '{"agent":"codex","installed":false}']) {
      await expect(installSkill("codex", async () => new Response(body, { status: 201 })))
        .rejects.toThrow("스킬을 설치하지 못했습니다");
    }
  });

  it("응답 크기를 제한하고 오류 원문을 노출하지 않는다", async () => {
    await expect(installSkill("cursor", async () => new Response("x".repeat(20_000), { status: 201 })))
      .rejects.toThrow("스킬을 설치하지 못했습니다");
    await expect(installSkill("cursor", async () => { throw new Error("private credential"); }))
      .rejects.toThrow("스킬을 설치하지 못했습니다");
  });
});
