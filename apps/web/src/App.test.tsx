import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import type {
  ExecutionEvidence,
  ExecutionResult,
  ExecutionVerdict,
  RunResponse,
  RunTest,
} from "./lib/api";
import { startFixtureRun } from "./lib/api";

vi.mock("./lib/api", () => ({ startFixtureRun: vi.fn() }));

const startRun = vi.mocked(startFixtureRun);

const runId = "run-6044f357-87cc-4f3c-b656-1fb4e9a83258";

/**
 * 2026-09-22 실측한 fixture 응답(오케스트레이터 fixture 모드, 201)의 골격 그대로입니다.
 * 지표가 샘플 값(2/2/3/3)과 구분되도록 파일 4개·가설 3개·테스트 4건으로만 늘렸습니다.
 */
const executionResult = (
  specId: string,
  hypothesisId: string,
  verdict: ExecutionVerdict,
  evidence: readonly ExecutionEvidence[],
): ExecutionResult => ({
  runId: `spec-${specId}`,
  hypothesisId,
  verdict,
  executed: true,
  evidence,
});

const runTest = (id: string, hypothesisId: string, actual: number): RunTest => ({
  id,
  request: { method: "POST", path: "/api/purchase", body: { itemId: "sword", price: -100 } },
  vulnerableResult: executionResult(id, hypothesisId, "CONFIRMED", [
    { kind: "status", expected: 400, actual },
  ]),
  patchedResult: executionResult(id, hypothesisId, "BLOCKED", []),
  regressionVerdict: "FIXED",
});

const buildReport = (): RunResponse => ({
  runId,
  provider: "fixture",
  model: "trustgate-fixture-plan",
  reviewedFiles: [
    "apps/demo-target/src/server.ts",
    "apps/demo-target/src/store.ts",
    "apps/demo-target/src/pricing.ts",
    "apps/demo-target/src/session.ts",
  ],
  hypotheses: [
    {
      id: "price-authority",
      title: "Server must own item prices instead of trusting the client",
      category: "price-tampering",
      severity: "high",
      tests: [
        runTest("negative-price", "price-authority", 200),
        runTest("oversized-quantity", "price-authority", 201),
      ],
      regressionVerdict: "FIXED",
    },
    {
      id: "ownership-check",
      title: "Purchase must reject items owned by another actor",
      category: "ownership-bypass",
      severity: "critical",
      tests: [runTest("foreign-item", "ownership-check", 200)],
      regressionVerdict: "FIXED",
    },
    {
      id: "session-scope",
      title: "Session tokens must not widen the actor scope",
      category: "authorization-bypass",
      severity: "medium",
      tests: [runTest("session-scope", "session-scope", 200)],
      regressionVerdict: "FIXED",
    },
  ],
  vulnerableResults: [],
  patchedResults: [],
  regressionVerdict: "FIXED",
  durations: { totalMs: 1840, ocrMs: 210, planningMs: 640, vulnerableMs: 470, patchedMs: 520 },
  source: "fixture",
});

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
};

const deferred = <Value,>(): Deferred<Value> => {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<Value>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const clickRun = (): HTMLElement => {
  const button = screen.getByRole("button", { name: "샘플 분석 실행" });
  fireEvent.click(button);
  return button;
};

const liveRegion = (): HTMLElement => screen.getByRole("status");

const metricItem = (label: string): HTMLElement => {
  const summary = screen.getByRole("region", { name: "요약 지표" });
  const node = within(summary).getByText(label).closest("li");
  expect(node).not.toBeNull();
  return node as HTMLElement;
};

const evidenceCard = (title: string): HTMLElement => {
  const section = screen.getByRole("region", { name: "실행 증거" });
  const node = within(section).getByText(title).closest("article");
  expect(node).not.toBeNull();
  return node as HTMLElement;
};

/** 팝업 금지는 화면 계약입니다: 어떤 상태에서도 dialog 노드가 없어야 합니다. */
const expectNoDialog = (): void => {
  expect(document.querySelector("dialog, [role=dialog]")).toBeNull();
};

beforeEach(() => {
  startRun.mockReset();
});

describe("TrustGate dashboard", () => {
  it("shows the four-stage evidence flow", () => {
    render(<App />);
    expect(screen.getByText("변경 파일")).toBeInTheDocument();
    expect(screen.getByText("취약점 가설")).toBeInTheDocument();
    expect(screen.getByText("격리 재현")).toBeInTheDocument();
    expect(screen.getByText("패치 회귀 검증")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "샘플 분석 실행" })).toBeEnabled();
    expect(metricItem("회귀 차단")).toHaveTextContent("3");
    expect(screen.getByText("샘플 값")).toBeInTheDocument();
    expectNoDialog();
  });
});

describe("샘플 실행 안내 라이브 리전", () => {
  it("렌더 직후에도 빈 상태의 status 리전이 머리말 안에 존재한다", () => {
    render(<App />);

    const region = liveRegion();

    // 노드가 클릭 시점에 삽입되면 보조기술이 낭독을 놓치므로, 항상 존재해야 합니다.
    expect(region).toBeEmptyDOMElement();
    expect(region.closest("header")).not.toBeNull();
  });

  it("실행 중에는 같은 리전 노드가 진행 문구를 낭독하고 버튼을 잠근다", async () => {
    const pending = deferred<RunResponse>();
    startRun.mockReturnValue(pending.promise);
    render(<App />);
    const region = liveRegion();

    const button = clickRun();

    expect(screen.getByRole("status")).toBe(region);
    await waitFor(() => {
      expect(region).toHaveTextContent("◌");
    });
    expect(region).toHaveTextContent("fixture 분석을 실행하는 중입니다");
    expect(region.closest("header")).not.toBeNull();
    expect(button).toBeDisabled();
    expect(startRun).toHaveBeenCalledTimes(1);
    // 진행 중에는 아직 결과가 없으므로 지표는 샘플 값을 유지합니다.
    expect(metricItem("검토 파일")).toHaveTextContent("2");
    expect(screen.getByText("샘플 값")).toBeInTheDocument();
    expectNoDialog();

    await act(async () => {
      pending.resolve(buildReport());
    });

    await waitFor(() => {
      expect(region).toHaveTextContent("분석 완료");
    });
    expect(screen.getByRole("button", { name: "샘플 분석 실행" })).toBeEnabled();
    expectNoDialog();
  });

  it("실패하면 서버 문구 대신 고정 오류 문구를 같은 리전에 남긴다", async () => {
    const pending = deferred<RunResponse>();
    startRun.mockReturnValue(pending.promise);
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    render(<App />);
    const region = liveRegion();

    clickRun();
    await act(async () => {
      pending.reject(new Error("이미 실행 중인 분석이 있습니다"));
    });

    await waitFor(() => {
      expect(region).toHaveTextContent("이미 실행 중인 분석이 있습니다");
    });
    expect(region).toHaveTextContent("!");
    expect(screen.getByRole("button", { name: "샘플 분석 실행" })).toBeEnabled();
    expect(alertSpy).not.toHaveBeenCalled();
    // 실패하면 지표와 증거 카드는 샘플 값을 유지합니다.
    expect(metricItem("검토 파일")).toHaveTextContent("2");
    expect(evidenceCard("수정 전 응답")).toHaveTextContent("HTTP 200");
    expectNoDialog();
    alertSpy.mockRestore();
  });
});

describe("fixture 실행 결과 렌더", () => {
  it("요약 지표를 report 값으로 바꾸고 실제 실행 결과 배지를 단다", async () => {
    const pending = deferred<RunResponse>();
    startRun.mockReturnValue(pending.promise);
    render(<App />);

    clickRun();
    await act(async () => {
      pending.resolve(buildReport());
    });

    await waitFor(() => {
      expect(screen.getByText("실제 실행 결과")).toBeInTheDocument();
    });
    expect(metricItem("검토 파일")).toHaveTextContent("4");
    expect(metricItem("도출 가설")).toHaveTextContent("3");
    expect(metricItem("재현 확정")).toHaveTextContent("4");
    expect(metricItem("회귀 차단")).toHaveTextContent("4");
    expect(screen.queryByText("샘플 값")).toBeNull();
    expect(screen.getByText(/숫자는 fixture-plan\.json을 실행한 결과에서 계산했습니다/)).toBeInTheDocument();
    expectNoDialog();
  });

  it("분석 흐름 단계를 report의 개수와 실측 meta로 갱신한다", async () => {
    const pending = deferred<RunResponse>();
    startRun.mockReturnValue(pending.promise);
    render(<App />);

    clickRun();
    await act(async () => {
      pending.resolve(buildReport());
    });

    const flow = screen.getByRole("region", { name: "분석 흐름" });
    await waitFor(() => {
      expect(within(flow).getByText("파일 4건")).toBeInTheDocument();
    });
    expect(within(flow).getByText("가설 3건")).toBeInTheDocument();
    expect(within(flow).getByText("재현 확정 4건")).toBeInTheDocument();
    expect(within(flow).getByText("회귀 통과 · 차단 4건")).toBeInTheDocument();
    expect(within(flow).getByText(/apps\/demo-target\/src\/session\.ts/)).toBeInTheDocument();
    expect(within(flow).getByText(/trustgate-fixture-plan/)).toBeInTheDocument();
    expectNoDialog();
  });

  it("실행 증거 카드를 report의 첫 테스트 값으로 다시 쓴다", async () => {
    const pending = deferred<RunResponse>();
    startRun.mockReturnValue(pending.promise);
    render(<App />);

    clickRun();
    await act(async () => {
      pending.resolve(buildReport());
    });

    await waitFor(() => {
      expect(evidenceCard("요청")).toHaveTextContent("POST /api/purchase");
    });
    expect(evidenceCard("요청")).toHaveTextContent('"price": -100');
    expect(evidenceCard("요청")).toHaveTextContent("가설 price-authority의 테스트 negative-price");
    expect(evidenceCard("수정 전 응답")).toHaveTextContent("판정 CONFIRMED");
    expect(evidenceCard("수정 전 응답")).toHaveTextContent("status: 기대 400, 실제 200");
    expect(evidenceCard("수정 후 응답")).toHaveTextContent("판정 BLOCKED");
    expect(evidenceCard("판정")).toHaveTextContent("회귀 판정: 회귀 통과 (FIXED)");
    // 샘플 카드의 본문(HTTP 코드)은 실제 결과로 대체됩니다.
    expect(screen.queryByText(/HTTP \d{3}/)).toBeNull();
    expectNoDialog();
  });

  it("성공 문구에 실행 식별자를 그대로 보여 준다", async () => {
    const pending = deferred<RunResponse>();
    startRun.mockReturnValue(pending.promise);
    render(<App />);

    clickRun();
    await act(async () => {
      pending.resolve(buildReport());
    });

    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent(`분석 완료 — 실행 ${runId}`);
    });
    expect(liveRegion().querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(liveRegion().closest("header")).not.toBeNull();
    expectNoDialog();
  });
});