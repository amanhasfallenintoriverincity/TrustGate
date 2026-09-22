import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * 대시보드 실왕복 검증: 브라우저 → vite dev(5173) → `/api` 프록시 → 오케스트레이터 fixture(8787).
 * 두 서버는 `../playwright.config.ts`의 `webServer`가 직접 띄우고 내립니다. mock도 stub도 없으므로
 * 실제 HTTP 경로가 끊기면 이 파일은 통과할 수 없습니다.
 */

/** fixture 실행 왕복(브라우저 → 프록시 → 오케스트레이터)이 끝날 때까지의 대기 예산입니다. */
const COMPLETION_TIMEOUT_MS = 15_000;

/**
 * 서버가 발급한 실행 ID(`run-<uuid>`)까지 문구에 포함해 확인합니다. 고정 문자열이 아니라 발급
 * 형식을 요구하므로, 문구가 화면 상수가 아니라 오케스트레이터 응답에서 왔다는 증거가 됩니다.
 */
const COMPLETION_TEXT =
  /분석 완료 — 실행 run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** 두 테스트가 같은 사용자 흐름을 겁니다: 실행 버튼 → 실제 201 응답 → 완료 문구. */
const runSampleAnalysis = async (page: Page): Promise<void> => {
  await page.goto("/");
  // 응답을 기다리기 시작하는 시점이 클릭보다 앞서야 합니다(뒤에 두면 이미 온 응답을 놓칩니다).
  const runResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/runs"),
  );
  await page.getByRole("button", { name: "샘플 분석 실행" }).click();
  // 201은 프록시 뒤 오케스트레이터가 실제로 실행을 끝내고 돌려준 상태 코드입니다.
  // 오케스트레이터가 죽어 있으면 vite 프록시가 500/502로 대신 답하므로 여기서 갈립니다.
  expect((await runResponse).status()).toBe(201);
  await expect(page.getByRole("status")).toContainText(COMPLETION_TEXT, {
    timeout: COMPLETION_TIMEOUT_MS,
  });
};

/**
 * 카드 제목(h3)이 정확히 일치하는 카드만 고릅니다. 판정 코드(CONFIRMED/FIXED)와 한국어 라벨이
 * 카드 본문·캡션에 함께 등장하므로, 문구 검색 대신 제목으로 컨테이너를 먼저 고정합니다.
 */
const cardTitled = (scope: Locator, page: Page, title: string): Locator =>
  scope.locator("article").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

test("fixture 분석이 실제 API 왕복으로 취약 재현과 회귀 통과를 보여준다", async ({ page }) => {
  await runSampleAnalysis(page);

  // 1) 요약 지표: '샘플 값' 배지가 사라지고 실제 실행 결과 배지로 교체됩니다.
  const metrics = page.getByRole("region", { name: "요약 지표" });
  await expect(metrics.getByText("샘플 값")).toHaveCount(0);
  await expect(metrics.getByText("실제 실행 결과")).toBeVisible();
  await expect(metrics.locator(".metric-label")).toHaveText([
    "검토 파일",
    "도출 가설",
    "재현 확정",
    "회귀 차단",
  ]);
  await expect(metrics.locator(".metric-value")).toHaveText(["2", "2", "3", "3"]);

  // 2) 실행 증거: 카드 4장이 첫 테스트의 요청·수정 전·수정 후·판정으로 채워집니다.
  const evidence = page.getByRole("region", { name: "실행 증거" });
  await expect(evidence.locator("article")).toHaveCount(4);
  const vulnerableCard = cardTitled(evidence, page, "수정 전 응답");
  await expect(vulnerableCard.getByText("취약 재현됨")).toBeVisible();
  const verdictCard = cardTitled(evidence, page, "판정");
  // 이 카드 안에는 상태 줄 외에 본문(`회귀 판정: 회귀 통과 (FIXED)`)과 캡션에도 같은 문구가
  // 있어 first()로 좁힙니다(DOM 순서상 상태 줄이 가장 앞입니다).
  await expect(verdictCard.getByText("회귀 통과").first()).toBeVisible();

  // 3) 분석 흐름: 회귀 단계 라벨이 같은 판정을 보여줍니다(이 카드 안에서는 문구가 유일).
  const flow = page.getByRole("region", { name: "분석 흐름" });
  await expect(cardTitled(flow, page, "패치 회귀 검증").getByText("회귀 통과")).toBeVisible();
});

test("360px 모바일 폭에서 실행 결과가 가로 오버플로 없이 렌더된다", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await runSampleAnalysis(page);

  // 빈 화면에서 재면 무효라서, 실행 증거 카드가 다 그려진 뒤에 잽니다.
  await expect(page.getByRole("region", { name: "실행 증거" }).locator("article")).toHaveCount(4);

  const measured = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    measured.scrollWidth - measured.clientWidth,
    `360px에서 가로 오버플로 ${measured.scrollWidth - measured.clientWidth}px ` +
      `(scrollWidth ${measured.scrollWidth} / clientWidth ${measured.clientWidth})`,
  ).toBeLessThanOrEqual(0);

  // 팝업/대화상자를 쓰지 않는다는 화면 계약: <dialog> 요소도 ARIA dialog 역할도 0건입니다.
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
