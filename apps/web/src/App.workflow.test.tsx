import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getSetup } from "./lib/setup";
import type { SetupStatus } from "./lib/setup";

vi.mock("./lib/setup", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lib/setup")>(),
  getSetup: vi.fn(),
}));

const fixture: SetupStatus = { mode: "fixture", configured: false, settings: null };
const workspace: SetupStatus = { mode: "workspace", configured: false, settings: null };
const requests = (): ReturnType<typeof vi.fn> => vi.fn();
const showStep = (step: string): void => {
  fireEvent.click(within(screen.getByRole("navigation", { name: "주 메뉴" })).getByRole("button", { name: step }));
};

beforeEach(() => {
  window.history.replaceState(null, "", "/#/setup");
  vi.mocked(getSetup).mockReset().mockResolvedValue(fixture);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("웹 작업 흐름", () => {
  it("기본 진입은 비어 있는 분석 대시보드이며 자동 실행하지 않는다", async () => {
    window.history.replaceState(null, "", "/");
    const fetcher = requests();
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "보안 분석 대시보드" })).toBeVisible();
    expect(screen.getByLabelText("분석 요약")).toHaveTextContent("분석 결과 없음");
    expect(screen.getByRole("button", { name: "프로젝트 분석 시작" })).toBeDisabled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("중복 안내와 샘플 실행 버튼을 없애고 상태 알림·법적 고지는 유지한다", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });

    expect(screen.queryByRole("navigation", { name: "작업 단계" })).not.toBeInTheDocument();
    expect(screen.queryByText("TRUSTGATE / WEB CONSOLE")).not.toBeInTheDocument();
    expect(screen.queryByText(/페이지 전환 · 분석 자동 실행 없음/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "관리 범위" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "샘플 분석 실행" })).toBeNull();
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("region", { name: "라이선스와 제3자 고지" })).toBeInTheDocument();
  });

  it("네 단계가 서로 다른 URL 화면으로 전환되고 설정 초안은 유지된다", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });
    const steps = screen.getByRole("navigation", { name: "주 메뉴" });
    for (const step of ["연결 설정", "프로젝트 선택/분석", "에이전트 스킬", "결과 확인"]) {
      expect(within(steps).getByRole("button", { name: step })).toBeEnabled();
    }
    expect(screen.getByRole("navigation", { name: "주 메뉴" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "첫 실행 설정" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "에이전트 스킬" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "요약 지표" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "draft-model" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 접기" }));
    expect(screen.getByRole("button", { name: "설정 펼치기" })).toBeInTheDocument();
    fireEvent.click(within(steps).getByRole("button", { name: "에이전트 스킬" }));
    expect(window.location.hash).toBe("#/skills");
    expect(within(steps).getByRole("button", { name: "에이전트 스킬" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("region", { name: "에이전트 스킬" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "첫 실행 설정" })).not.toBeInTheDocument();
    fireEvent.click(within(steps).getByRole("button", { name: "연결 설정" }));
    expect(window.location.hash).toBe("#/setup");
    expect(screen.getByRole("button", { name: "설정 접기" })).toBeInTheDocument();
    expect(screen.getByLabelText("모델")).toHaveValue("draft-model");
    expect(document.querySelector(".headline")).toBeNull();
  });

  it("shadcn Stepper가 현재 단계를 표시하고 탐색해도 실행을 자동 시작하지 않는다", async () => {
    const fetcher = requests();
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });
    const steps = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(within(steps).getByRole("button", { name: /연결 설정/ })).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(steps).getByRole("button", { name: /결과 확인/ }));
    expect(window.location.hash).toBe("#/results");
    expect(within(steps).getByRole("button", { name: /결과 확인/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("region", { name: "요약 지표" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "첫 실행 설정" })).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "샘플 분석 실행" })).toBeNull();
  });

  it("직접 URL 접근과 뒤로/앞으로 가기에서 현재 화면을 복원하고 요청을 보내지 않는다", async () => {
    window.history.replaceState(null, "", "/#/project");
    const fetcher = requests();
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    expect(screen.getByRole("heading", { name: "프로젝트 선택/분석" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "첫 실행 설정" })).not.toBeInTheDocument();
    const steps = screen.getByRole("navigation", { name: "주 메뉴" });
    fireEvent.click(within(steps).getByRole("button", { name: "결과 확인" }));
    expect(window.location.hash).toBe("#/results");
    window.history.replaceState(null, "", "/#/project");
    fireEvent.popState(window);
    expect(screen.getByRole("heading", { name: "프로젝트 선택/분석" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "요약 지표" })).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("대시보드의 주요 동작과 카드가 shadcn/ui 프리미티브를 사용한다", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });
    expect(screen.queryByRole("button", { name: "샘플 분석 실행" })).toBeNull();
    showStep("결과 확인");
    expect(screen.getByRole("region", { name: "요약 지표" })).toHaveAttribute("data-slot", "card");
    showStep("연결 설정");
    expect(screen.getByLabelText("기본 URL")).toHaveAttribute("data-slot", "input");
  });

  it("fixture 모드에서는 설치가 잠기고 클릭하지 않으면 설치 요청이 없다", async () => {
    const fetcher = requests();
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });
    showStep("에이전트 스킬");
    const skills = screen.getByRole("region", { name: "에이전트 스킬" });
    expect(document.body).toHaveTextContent("TRUSTGATE_WORKSPACE_ROOT");
    expect(document.body).toHaveTextContent("TRUSTGATE_MODE=workspace");
    expect(skills).toHaveTextContent("Hermes");
    for (const agent of ["Codex", "Claude", "Cursor", "Hermes"]) {
      expect(within(skills).getByRole("button", { name: `${agent} 스킬 설치` })).toBeDisabled();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("실행 전에는 완료된 단계나 증거를 보여 주지 않는다", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });
    showStep("결과 확인");
    const results = screen.getByRole("region", { name: "요약 지표" });
    expect(results).toHaveTextContent("분석 결과 없음");
    expect(results).not.toHaveTextContent("실제 실행 결과");
    const evidence = screen.getByRole("region", { name: "실행 증거" });
    expect(evidence).toHaveTextContent("실행 증거 없음");
    expect(evidence.querySelectorAll("article")).toHaveLength(0);
  });

  it("workspace 모드에서 명시적으로 누른 에이전트만 POST하고 정확한 201 응답 뒤 설치 표시", async () => {
    vi.mocked(getSetup).mockResolvedValue(workspace);
    let finish: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    showStep("에이전트 스킬");
    const skills = await screen.findByRole("region", { name: "에이전트 스킬" });
    await waitFor(() => expect(within(skills).getByRole("button", { name: "Codex 스킬 설치" })).toBeEnabled());
    expect(fetcher).not.toHaveBeenCalled();
    const button = within(skills).getByRole("button", { name: "Codex 스킬 설치" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/skills/install", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "codex" }),
    });
    expect(button).toBeDisabled();
    expect(skills).not.toHaveTextContent("Codex 설치 완료");
    await act(async () => { finish?.(new Response(JSON.stringify({ agent: "codex", installed: true }), { status: 201 })); });
    expect(skills).toHaveTextContent("Codex 설치 완료");
    expect(within(skills).getByRole("button", { name: "Claude 스킬 설치" })).toBeEnabled();
  });

  it("409는 이미 존재하는 파일로 알리고 새 설치 성공으로 처리하지 않는다", async () => {
    vi.mocked(getSetup).mockResolvedValue(workspace);
    const fetcher = vi.fn(async () => new Response("ignored", { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    showStep("에이전트 스킬");
    const skills = await screen.findByRole("region", { name: "에이전트 스킬" });
    const button = within(skills).getByRole("button", { name: "Hermes 스킬 설치" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await within(skills).findByText(/Hermes.*이미 설치/)).toBeInTheDocument();
    expect(skills).not.toHaveTextContent("Hermes 설치 완료");
    expect(button).toBeEnabled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("비정상 201과 서버 오류는 설치 성공으로 표시하지 않고 응답 원문도 노출하지 않는다", async () => {
    vi.mocked(getSetup).mockResolvedValue(workspace);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ agent: "cursor", installed: false }), { status: 201 }))
      .mockResolvedValueOnce(new Response("secret-in-error", { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    render(<App />);
    showStep("에이전트 스킬");
    const skills = await screen.findByRole("region", { name: "에이전트 스킬" });
    const button = within(skills).getByRole("button", { name: "Cursor 스킬 설치" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await within(skills).findByText(/Cursor.*설치하지 못했습니다/)).toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(skills).not.toHaveTextContent("Cursor 설치 완료");
    expect(skills).not.toHaveTextContent("secret-in-error");
  });
});
