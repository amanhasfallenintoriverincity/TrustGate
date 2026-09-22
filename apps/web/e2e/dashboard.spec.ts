import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * 대시보드 실왕복 검증: 브라우저 → vite dev(5173) → `/api` 프록시 → 오케스트레이터 fixture(8787).
 * 두 서버는 `../playwright.config.ts`의 `webServer`가 직접 띄우고 내립니다(점유 포트 재사용 없음).
 * mock도 stub도 없으므로 실제 HTTP 경로가 끊기면 이 파일은 통과할 수 없습니다.
 */

/** fixture 실행 왕복(브라우저 → 프록시 → 오케스트레이터)이 끝날 때까지의 대기 예산입니다. */
const COMPLETION_TIMEOUT_MS = 15_000;

/**
 * 서버가 발급한 실행 ID(`run-<uuid>`)까지 문구에 포함해 확인합니다. 고정 문자열이 아니라 발급
 * 형식을 요구하므로, 문구가 화면 상수가 아니라 오케스트레이터 응답에서 왔다는 증거가 됩니다.
 */
const COMPLETION_TEXT =
  /분석 완료 — 실행 run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** 지표 배지 문구. 화면 상수(`App.tsx`)와 같은 문자열입니다. */
const SAMPLE_BADGE = "샘플 값";
const RESULT_BADGE = "실제 실행 결과";

/**
 * 문구를 정규식에 그대로 넣기 위한 이스케이프입니다. 상태 문구는 화면 상수라 지금은 메타문자가
 * 없지만, 문구를 고칠 때 정규식이 다른 문자열을 조용히 매칭하는 일을 막습니다.
 */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 상태 문구·배지의 정확 일치 패턴입니다. 상태 요소는 장식 아이콘(`TONE_ICON`, `aria-hidden`)과
 * 문구를 한 요소에 담으므로(`✓ 실제 실행 결과`) 문구만으로는 완전 일치가 성립하지 않습니다.
 * 아이콘 자리(비공백 0~2자)만 허용하고 문구는 끝까지 정확히 요구합니다.
 */
const statusText = (label: string): RegExp => new RegExp(`^\\S{0,2}\\s*${escapeRegExp(label)}$`);

/**
 * 요약 지표 배지 = `.section-head`의 직계 span입니다. 리전 전체에서 문구를 찾으면 안내 문장
 * (`section-foot`의 "…실제 실행 결과로 바뀝니다")에도 같은 단어가 들어 있어 샘플 상태에서도
 * 매칭됩니다(리뷰 LOW-2 실측: pre 상태 매치 = `P.section-foot`). 배지 자체만 봐야 교체를 식별합니다.
 */
const metricsBadge = (page: Page): Locator =>
  page.getByRole("region", { name: "요약 지표" }).locator(".section-head > span");

/**
 * 카드의 상태 줄(`p.status`)만 고릅니다. 같은 판정 문구가 본문(`회귀 판정: 회귀 통과 (FIXED)`)과
 * 캡션에도 들어 있어, `.first()`는 DOM 순서에 기대게 됩니다(리뷰 LOW-4). 상태 줄 하나로 좁히면
 * 순서와 무관하게 같은 주장을 유지합니다.
 */
const cardStatus = (card: Locator): Locator => card.locator("p.status");

/** 두 테스트가 같은 사용자 흐름을 겁니다: 실행 버튼 → 실제 201 응답 → 완료 문구. */
const runSampleAnalysis = async (page: Page): Promise<void> => {
  await page.goto("/");
  // 응답을 기다리기 시작하는 시점이 클릭보다 앞서야 합니다(뒤에 두면 이미 온 응답을 놓칩니다).
  const runResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().endsWith("/api/runs"),
  );
  // 정확 일치로 겁니다. 부분 일치는 변이된 라벨(`샘플 분석 실행 (STALE-MIRROR-SERVER)`)까지
  // 매칭해 다른 코드 트리의 버튼을 누를 수 있습니다(리뷰 LOW-3).
  await page.getByRole("button", { name: "샘플 분석 실행", exact: true }).click();
  // 201은 프록시 뒤 오케스트레이터가 실제로 실행을 끝내고 돌려준 상태 코드입니다.
  // 오케스트레이터가 죽어 있으면 vite 프록시가 500/502로 대신 답하므로 여기서 갈립니다.
  expect((await runResponse).status()).toBe(201);
  // 이 문구는 오케스트레이터가 발급한 runId를 포함하므로 샘플 상태에서는 나올 수 없습니다.
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
  await expect(metricsBadge(page)).toHaveText(statusText(RESULT_BADGE));
  await expect(metrics.getByText(SAMPLE_BADGE)).toHaveCount(0);
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
  await expect(cardStatus(vulnerableCard)).toHaveText(statusText("취약 재현됨"));
  const verdictCard = cardTitled(evidence, page, "판정");
  await expect(cardStatus(verdictCard)).toHaveText(statusText("회귀 통과"));

  // 3) 분석 흐름: 회귀 단계 라벨이 같은 판정을 보여줍니다(차단 건수는 지표 값과 같은 실행에서 옵니다).
  const flow = page.getByRole("region", { name: "분석 흐름" });
  await expect(cardStatus(cardTitled(flow, page, "패치 회귀 검증"))).toHaveText(
    statusText("회귀 통과 · 차단 3건"),
  );
});

test("360px 모바일 폭에서 실행 결과가 가로 오버플로 없이 렌더된다", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await runSampleAnalysis(page);

  // 빈 화면·샘플 상태에서 재면 무효입니다. 샘플 상태도 증거 카드 4장을 그리므로 개수만으로는 실제
  // 실행 결과인지 알 수 없습니다(리뷰 LOW-4 실측: 샘플 상태 article 4장). 배지가 실제 실행 결과로
  // 바뀐 것을 함께 요구한 뒤에 잽니다.
  const evidence = page.getByRole("region", { name: "실행 증거" });
  await expect(metricsBadge(page)).toHaveText(statusText(RESULT_BADGE));
  await expect(evidence.locator("article")).toHaveCount(4);

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
