import { act, fireEvent, render as renderPage, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import type {
  ExecutionEvidence,
  ExecutionResult,
  ExecutionVerdict,
  JsonValue,
  RegressionVerdict,
  RunResponse,
  RunTest,
} from "./lib/api";
import { getSetup, startWorkspaceRun } from "./lib/setup";
import type { SetupStatus } from "./lib/setup";

const workspaceStatus: SetupStatus = { mode: "workspace", configured: true, settings: null };
vi.mock("./lib/setup", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lib/setup")>(),
  getSetup: vi.fn(),
  startWorkspaceRun: vi.fn(),
}));

const startRun = vi.mocked(startWorkspaceRun);
const getSetupMock = vi.mocked(getSetup);
/** 이 스위트는 workspace 실행 버튼이 있는 프로젝트 화면에서 시작합니다. */
const render = (ui: ReactElement): ReturnType<typeof renderPage> => {
  window.history.replaceState(null, "", "/");
  const view = renderPage(ui);
  goToProject();
  return view;
};

const goToProject = (): void => {
  fireEvent.click(within(screen.getByRole("navigation", { name: "주 메뉴" })).getByRole("button", { name: "프로젝트 선택/분석" }));
};

const goToResults = (): void => {
  fireEvent.click(within(screen.getByRole("navigation", { name: "주 메뉴" })).getByRole("button", { name: "결과 확인" }));
};

const runId = "run-6044f357-87cc-4f3c-b656-1fb4e9a83258";

/**
 * workspace 실행 보고서(오케스트레이터 201)의 골격입니다.
 * 파일 4개·가설 3개·테스트 4건으로 늘려 화면이 보고서 값을 그대로 읽는지 확인합니다.
 */
const executionResult = (
  specId: string,
  hypothesisId: string,
  verdict: ExecutionVerdict,
  evidence: readonly ExecutionEvidence[],
  executed = true,
): ExecutionResult => ({
  runId: `spec-${specId}`,
  hypothesisId,
  verdict,
  executed,
  evidence,
});

/** 계약(contracts)상 CONFIRMED/UNVERIFIED/ERROR는 근거가 있고, BLOCKED는 비어 있어야 합니다. */
const evidenceFor = (verdict: ExecutionVerdict): readonly ExecutionEvidence[] => {
  switch (verdict) {
    case "CONFIRMED":
      return [{ kind: "status", expected: 400, actual: 200 }];
    case "BLOCKED":
      return [];
    case "UNVERIFIED":
    case "ERROR":
      return [{ kind: "status", expected: 400, actual: 500 }];
  }
};

/** 계약상 CONFIRMED/BLOCKED만 실행 완료(executed) 상태입니다. */
const executedFor = (verdict: ExecutionVerdict): boolean =>
  verdict === "CONFIRMED" || verdict === "BLOCKED";

const runTest = (id: string, hypothesisId: string, actual: number): RunTest => ({
  id,
  request: { method: "POST", path: "/api/purchase", body: { itemId: "sword", price: -100 } },
  vulnerableResult: executionResult(id, hypothesisId, "CONFIRMED", [
    { kind: "status", expected: 400, actual },
  ]),
  patchedResult: executionResult(id, hypothesisId, "BLOCKED", []),
  regressionVerdict: "FIXED",
});

/** 판정을 직접 고르는 테스트 한 건입니다(수정 전/수정 후/회귀 판정을 각각 지정). */
const verdictTest = (
  id: string,
  hypothesisId: string,
  vulnerable: ExecutionVerdict,
  patched: ExecutionVerdict,
  regression: RegressionVerdict,
): RunTest => ({
  id,
  request: { method: "POST", path: "/api/purchase", body: { itemId: "sword", price: -100 } },
  vulnerableResult: executionResult(
    id,
    hypothesisId,
    vulnerable,
    evidenceFor(vulnerable),
    executedFor(vulnerable),
  ),
  patchedResult: executionResult(
    id,
    hypothesisId,
    patched,
    evidenceFor(patched),
    executedFor(patched),
  ),
  regressionVerdict: regression,
});

const buildReport = (): RunResponse => ({
  runId,
  provider: "openai-compatible",
  model: "test-model",
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
  source: "workspace",
});

/**
 * 판정이 섞인 응답입니다. 테스트는 3건인데 재현 확정 2건·회귀 차단 2건이고, 집계 판정은
 * 여전히 취약(STILL_VULNERABLE)입니다. 카운트가 총계(3)나 첫 테스트 판정(FIXED)으로
 * 퇴화하면 이 응답에서 값이 어긋납니다.
 */
const buildMixedReport = (): RunResponse => ({
  runId,
  provider: "openai-compatible",
  model: "test-model",
  reviewedFiles: ["apps/demo-target/src/server.ts", "apps/demo-target/src/store.ts"],
  hypotheses: [
    {
      id: "price-authority",
      title: "Server must own item prices instead of trusting the client",
      category: "price-tampering",
      severity: "high",
      tests: [
        verdictTest("negative-price", "price-authority", "CONFIRMED", "BLOCKED", "FIXED"),
        verdictTest("oversized-quantity", "price-authority", "CONFIRMED", "BLOCKED", "FIXED"),
      ],
      regressionVerdict: "FIXED",
    },
    {
      id: "ownership-check",
      title: "Purchase must reject items owned by another actor",
      category: "ownership-bypass",
      severity: "critical",
      tests: [
        verdictTest("foreign-item", "ownership-check", "ERROR", "CONFIRMED", "STILL_VULNERABLE"),
      ],
      regressionVerdict: "STILL_VULNERABLE",
    },
  ],
  vulnerableResults: [],
  patchedResults: [],
  regressionVerdict: "STILL_VULNERABLE",
  durations: { totalMs: 1840, ocrMs: 210, planningMs: 640, vulnerableMs: 470, patchedMs: 520 },
  source: "workspace",
});

/** 가설 하나·테스트 하나뿐인 응답입니다(증거 카드는 첫 테스트만 그립니다). */
const buildSingleTestReport = (
  vulnerable: ExecutionVerdict,
  patched: ExecutionVerdict,
  regression: RegressionVerdict,
): RunResponse => ({
  ...buildReport(),
  hypotheses: [
    {
      id: "price-authority",
      title: "Server must own item prices instead of trusting the client",
      category: "price-tampering",
      severity: "high",
      tests: [verdictTest("negative-price", "price-authority", vulnerable, patched, regression)],
      regressionVerdict: regression,
    },
  ],
  regressionVerdict: regression,
});

/**
 * 2026-09-22 리뷰 P8 재현: `request.body`가 깊게 중첩되면 `JSON.stringify(_, null, 2)`가
 * `RangeError: Maximum call stack size exceeded`를 던지고(엔진 실측: pretty는 10k에서 throw,
 * compact는 500k까지 안전), 에러 바운더리가 없어 화면이 통째로 지워졌습니다
 * (document.body 길이 11, 브랜드 텍스트 소실). 가드는 body 값을 확인하지 않으므로 이 응답은
 * 화면 계약상 유효하고, 렌더 경로가 값을 고정 문구로 낮춰 나머지 섹션을 지켜야 합니다.
 */
const deepJsonBody = (depth: number): JsonValue => {
  let value: JsonValue = "leaf";
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
};

const DEEP_BODY_DEPTH = 20_000;

/** 깊은 body 한 건을 포함하되 지표는 2/2/3/3(검토 파일 2·가설 2·재현 확정 3·회귀 차단 3)입니다. */
const buildDeepRequestBody = (): RunResponse => ({
  ...buildReport(),
  reviewedFiles: ["apps/demo-target/src/server.ts", "apps/demo-target/src/store.ts"],
  hypotheses: [
    {
      id: "price-authority",
      title: "Server must own item prices instead of trusting the client",
      category: "price-tampering",
      severity: "high",
      tests: [
        {
          ...runTest("negative-price", "price-authority", 200),
          request: {
            method: "POST",
            path: "/api/purchase",
            body: deepJsonBody(DEEP_BODY_DEPTH),
          },
        },
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
  ],
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

/** 실행 버튼은 workspace 설정이 로드된 뒤에만 노출되므로 비동기로 찾습니다. */
const findRunButton = (): Promise<HTMLElement> =>
  screen.findByRole("button", { name: "프로젝트 분석" });

/** 프로젝트 화면으로 이동한 뒤 실행 버튼을 누릅니다. 분석이 끝나면 결과 화면으로 넘어갑니다. */
const clickRun = async (): Promise<HTMLElement> => {
  goToProject();
  const button = await findRunButton();
  fireEvent.click(button);
  return button;
};

/** 분석이 끝나면 결과 화면으로 이동하므로, 실행 버튼 상태를 보려면 프로젝트 화면으로 되돌아간다. */
const runButton = async (): Promise<HTMLElement> => {
  goToProject();
  return findRunButton();
};

/** 실행을 시작해 결과까지 화면에 반영한 뒤 돌아옵니다. */
const renderReport = async (report: RunResponse): Promise<void> => {
  const pending = deferred<RunResponse>();
  startRun.mockReturnValue(pending.promise);
  render(<App />);

  await clickRun();
  await act(async () => {
    pending.resolve(report);
  });

  await waitFor(() => {
    expect(screen.getByText("실제 실행 결과")).toBeInTheDocument();
  });
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
  getSetupMock.mockReset().mockResolvedValue(workspaceStatus);
  startRun.mockReset();
});

describe("TrustGate dashboard", () => {
  it("프로젝트 화면에 실행 버튼을 두고 결과 화면은 비어 있는 상태로 시작한다", async () => {
    render(<App />);
    expect(await screen.findByRole("region", { name: "프로젝트 분석" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "샘플 분석 실행" })).toBeNull();
    goToResults();
    expect(metricItem("회귀 차단")).toHaveTextContent("—");
    for (const label of ["검토 파일", "도출 가설", "재현 확정", "회귀 차단"]) {
      expect(metricItem(label)).toHaveTextContent("—");
    }
    expectNoDialog();
    expect(screen.queryByText("변경 파일")).toBeNull();
    expect(screen.queryByText("취약점 가설")).toBeNull();
    expect(screen.getByText("프로젝트 분석을 실행하면 단계마다 판정 근거가 남습니다.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "실행 증거" })).toHaveTextContent("실행 증거 없음");
    expectNoDialog();
  });
});

describe("실행 상태 안내 라이브 리전", () => {
  it("렌더 직후에도 빈 상태의 status 리전이 머리말 안에 존재한다", () => {
    render(<App />);

    const region = liveRegion();

    // 노드가 클릭 시점에 삽입되면 보조기술이 낭독을 놓치므로, 항상 존재해야 합니다.
    expect(region).toBeEmptyDOMElement();
    expect(region.closest("header")).not.toBeNull();
  });

  it("빈 리전 숨김 레시피가 거는 클래스와 aria-live를 유지한다", () => {
    render(<App />);

    const region = liveRegion();

    // index.css의 빈 리전 숨김은 `.action-notice:empty`에만 걸립니다. 클래스나
    // aria-live가 바뀌면 1px clip-path 숨김도 낭독도 함께 끊깁니다.
    expect(region).toHaveClass("action-notice");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region.getAttribute("class")).toBe("action-notice");
  });

  it("실행 중에는 같은 리전 노드가 진행 문구를 낭독하고 버튼을 잠근다", async () => {
    const pending = deferred<RunResponse>();
    startRun.mockReturnValue(pending.promise);
    render(<App />);
    const region = liveRegion();

    const button = await clickRun();

    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveClass("action-notice");
    expect(region).toHaveAttribute("aria-live", "polite");
    await waitFor(() => {
      expect(region).toHaveTextContent("◌");
    });
    expect(region).toHaveTextContent("프로젝트 분석을 실행하는 중입니다");
    expect(region.closest("header")).not.toBeNull();
    expect(startRun).toHaveBeenCalledTimes(1);
    // 진행 중에는 아직 결과가 없으므로 지표는 빈 값을 유지합니다.
    expect(metricItem("검토 파일")).toHaveTextContent("—");
    expectNoDialog();
    // 분석 시작 시 결과 화면으로 이동하므로 실행 버튼 상태는 프로젝트 화면에서 확인합니다.
    expect(await runButton()).toBeDisabled();

    await act(async () => {
      pending.resolve(buildReport());
    });

    await waitFor(() => {
      expect(region).toHaveTextContent(`프로젝트 분석 완료 — 실행 ${runId}`);
    });
    expect(await runButton()).toBeEnabled();
    expectNoDialog();
  });

  it("실패하면 서버 문구 대신 고정 오류 문구를 같은 리전에 남긴다", async () => {
    const pending = deferred<RunResponse>();
    startRun.mockReturnValue(pending.promise);
    render(<App />);
    const region = liveRegion();

    await clickRun();
    await act(async () => {
      pending.reject(new Error("server-private-key"));
    });

    await waitFor(() => {
      expect(region).toHaveTextContent("프로젝트 분석에 실패했습니다");
    });
    expect(region).toHaveTextContent("!");
    expect(region).not.toHaveTextContent("server-private-key");
    expect(metricItem("검토 파일")).toHaveTextContent("—");
    expect(screen.getByRole("region", { name: "실행 증거" })).toHaveTextContent("실행 증거 없음");
    expect(await runButton()).toBeEnabled();
    expectNoDialog();
  });
});

describe("실행 재진입 가드", () => {
  it("같은 태스크에서 두 번 눌러도 POST는 한 번만 나가고 버튼은 잠긴다", async () => {
    const pending = deferred<RunResponse>();
    startRun.mockReturnValue(pending.promise);
    render(<App />);
    const button = await findRunButton();

    // 버튼의 disabled는 다음 렌더 뒤에 붙습니다. 두 번째 클릭이 그 전에 들어오면
    // 이전에는 POST가 두 번 나갔습니다.
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(startRun).toHaveBeenCalledTimes(1);
    expect(await runButton()).toBeDisabled();
    expectNoDialog();
  });

  it("실행이 끝나면 다음 실행은 다시 나간다", async () => {
    const first = deferred<RunResponse>();
    const second = deferred<RunResponse>();
    startRun.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<App />);

    await clickRun();
    await act(async () => {
      first.resolve(buildReport());
    });
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent(`프로젝트 분석 완료 — 실행 ${runId}`);
    });

    await clickRun();

    expect(startRun).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve(buildReport());
    });
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent(`프로젝트 분석 완료 — 실행 ${runId}`);
    });
  });

  it("실패한 뒤에도 버튼이 풀리고 두 번째 클릭이 새 POST를 보낸다", async () => {
    const first = deferred<RunResponse>();
    const second = deferred<RunResponse>();
    startRun.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<App />);

    await clickRun();
    await act(async () => {
      first.reject(new Error("분석 실행이 실패했습니다"));
    });
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent("프로젝트 분석에 실패했습니다");
    });
    // 실패 경로도 실행 잠금을 풀어야 합니다(해제가 finally 밖으로 새면 여기서 잠깁니다).
    expect(await runButton()).toBeEnabled();

    // 분석 시작과 함께 결과 화면으로 이동하므로, 두 번째 실행은 프로젝트 화면에서 누릅니다.
    await clickRun();

    expect(startRun).toHaveBeenCalledTimes(2);
    const secondButton = await runButton();
    expect(secondButton).toBeDisabled();
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent("프로젝트 분석을 실행하는 중입니다");
    });

    await act(async () => {
      second.resolve(buildReport());
    });
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent(`프로젝트 분석 완료 — 실행 ${runId}`);
    });
    expectNoDialog();
  });
});

describe("깊은 request.body 렌더 경계", () => {
  it("20k 깊이 body도 흰 화면 없이 고정 문구로 낮추고 나머지 섹션을 지킨다", async () => {
    await renderReport(buildDeepRequestBody());

    // 1) 브랜드 문구와 페이지 내용이 살아 있습니다(리뷰 재현: 흰 화면에서 body 길이 11).
    expect(screen.getByText("TrustGate")).toBeInTheDocument();
    const page = document.body.textContent ?? "";
    expect(page.length).toBeGreaterThan(200);
    // 엔진 원문(RangeError/스택 문구)은 화면 계약상 노출 금지입니다.
    expect(page).not.toMatch(/RangeError|Maximum call stack|stack size exceeded/);

    // 2) 결과·법적 고지 섹션이 남고 지표는 report 값(2/2/3/3)입니다.
    for (const name of ["요약 지표", "분석 흐름", "실행 증거", "라이선스와 제3자 고지"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
    expect(metricItem("검토 파일")).toHaveTextContent("2");
    expect(metricItem("도출 가설")).toHaveTextContent("2");
    expect(metricItem("재현 확정")).toHaveTextContent("3");
    expect(metricItem("회귀 차단")).toHaveTextContent("3");
    expect(screen.getByText("실제 실행 결과")).toBeInTheDocument();

    // 3) 깊은 값은 pretty-print 대신 고정 문구로만, 나머지 실행 증거는 그대로입니다.
    const request = evidenceCard("요청");
    expect(request).toHaveTextContent("POST /api/purchase");
    expect(request).toHaveTextContent("표시할 수 없는 값입니다");
    expect(request).not.toHaveTextContent("nested");
    expect(evidenceCard("수정 전 응답")).toHaveTextContent("판정 CONFIRMED");
    expect(evidenceCard("판정")).toHaveTextContent("회귀 통과");
    expectNoDialog();
  });

  it("얕은 body는 기존과 같은 pretty JSON으로 남는다", async () => {
    await renderReport(buildReport());

    const request = evidenceCard("요청");
    expect(request).toHaveTextContent("POST /api/purchase");
    expect(request).toHaveTextContent('"price": -100');
    expect(request).not.toHaveTextContent("표시할 수 없는 값입니다");
  });
});

describe("workspace 실행 결과 렌더", () => {
  it("요약 지표를 report 값으로 바꾸고 실제 실행 결과 배지를 단다", async () => {
    const pending = deferred<RunResponse>();
    startRun.mockReturnValue(pending.promise);
    render(<App />);

    await clickRun();
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
    expect(screen.queryByText("분석 결과 없음")).toBeNull();
    expect(screen.getByText(/숫자는 이번 workspace 실행 보고서에서 계산했습니다/)).toBeInTheDocument();
    expectNoDialog();
  });

  it("분석 흐름 단계를 report의 개수와 실측 meta로 갱신한다", async () => {
    const pending = deferred<RunResponse>();
    startRun.mockReturnValue(pending.promise);
    render(<App />);

    await clickRun();
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
    expect(within(flow).getByText(/openai-compatible \/ test-model/)).toBeInTheDocument();
    expectNoDialog();
  });

  it("실행 증거 카드를 report의 첫 테스트 값으로 다시 쓴다", async () => {
    const pending = deferred<RunResponse>();
    startRun.mockReturnValue(pending.promise);
    render(<App />);

    await clickRun();
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
    expect(screen.queryByText(/HTTP \d{3}/)).toBeNull();
    expectNoDialog();
  });

  it("성공 문구에 실행 식별자를 그대로 보여 준다", async () => {
    const pending = deferred<RunResponse>();
    startRun.mockReturnValue(pending.promise);
    render(<App />);

    await clickRun();
    await act(async () => {
      pending.resolve(buildReport());
    });

    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent(`프로젝트 분석 완료 — 실행 ${runId}`);
    });
    expect(liveRegion().querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(liveRegion().closest("header")).not.toBeNull();
    expectNoDialog();
  });
});

describe("혼합 판정 카운트", () => {
  it("총계가 아니라 판정별로 세고 단계 문구도 같은 수를 쓴다", async () => {
    await renderReport(buildMixedReport());

    expect(metricItem("검토 파일")).toHaveTextContent("2");
    expect(metricItem("도출 가설")).toHaveTextContent("2");
    expect(metricItem("재현 확정")).toHaveTextContent("2");
    expect(metricItem("회귀 차단")).toHaveTextContent("2");
    // 테스트는 3건이지만 판정별 카운트는 2건입니다: 총계로 퇴화하면 여기서 깨집니다.
    expect(metricItem("재현 확정")).not.toHaveTextContent("3");
    expect(metricItem("회귀 차단")).not.toHaveTextContent("3");

    const flow = screen.getByRole("region", { name: "분석 흐름" });
    expect(within(flow).getByText("재현 확정 2건")).toBeInTheDocument();
    expect(within(flow).getByText("여전히 취약 · 차단 2건")).toBeInTheDocument();
    expect(within(flow).queryByText("재현 확정 3건")).toBeNull();
    expect(within(flow).queryByText("회귀 통과 · 차단 3건")).toBeNull();

    // 증거 카드는 첫 테스트(FIXED)로 그리고, 캡션은 집계 판정과 전체 건수를 밝힙니다.
    expect(evidenceCard("판정")).toHaveTextContent("회귀 판정: 회귀 통과 (FIXED)");
    expect(evidenceCard("판정")).toHaveTextContent("전체 판정: 여전히 취약 (STILL_VULNERABLE)");
    expect(evidenceCard("판정")).toHaveTextContent("테스트 3건 중 첫 건");
    expect(evidenceCard("요청")).toHaveTextContent("가설 price-authority의 테스트 negative-price");
    expectNoDialog();
  });

  it("집계 판정이 여전히 취약이면 회귀 단계를 위험 색·문구로 표시한다", async () => {
    await renderReport(buildMixedReport());

    const flow = screen.getByRole("region", { name: "분석 흐름" });
    const regression = within(flow).getByText("여전히 취약 · 차단 2건");

    expect(regression).toHaveClass("status", "status-danger");
    expect(regression.querySelector('[aria-hidden="true"]')).toHaveTextContent("!");
  });
});

describe("증거 카드 한국어 판정 문구", () => {
  it.each<[ExecutionVerdict, string]>([
    ["CONFIRMED", "취약 재현됨"],
    ["BLOCKED", "차단 확인"],
    ["UNVERIFIED", "판정 보류"],
    ["ERROR", "실행 오류"],
  ])("수정 전 응답 카드: %s → %s", async (verdict, label) => {
    await renderReport(buildSingleTestReport(verdict, "BLOCKED", "FIXED"));

    const card = evidenceCard("수정 전 응답");

    expect(card).toHaveTextContent(label);
    expect(card).toHaveTextContent(`판정 ${verdict}`);
    expect(card).toHaveTextContent(executedFor(verdict) ? "실행 완료" : "미실행");
  });

  it.each<[RegressionVerdict, string]>([
    ["FIXED", "회귀 통과"],
    ["STILL_VULNERABLE", "여전히 취약"],
    ["NOT_REPRODUCED", "재현 안 됨"],
    ["UNVERIFIED", "판정 불가"],
  ])("판정 카드: %s → %s", async (verdict, label) => {
    await renderReport(buildSingleTestReport("CONFIRMED", "BLOCKED", verdict));

    const card = evidenceCard("판정");

    expect(card).toHaveTextContent(label);
    expect(card).toHaveTextContent(`회귀 판정: ${label} (${verdict})`);
  });
});
