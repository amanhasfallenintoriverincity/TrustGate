import { expect, test } from "@playwright/test";

/**
 * 대시보드 실왕복 검증: 브라우저 → vite dev(5173) → `/api` 프록시 → 오케스트레이터(8787).
 * 두 서버는 `../playwright.config.ts`의 `webServer`가 직접 띄우고 내립니다(점유 포트 재사용 없음).
 */

test("Stepper는 단계마다 다른 URL 화면을 보여주며 탐색만으로 분석하지 않는다", async ({ page }) => {
  const runRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/runs")) runRequests.push(request.url());
  });
  await page.goto("/");

  const steps = page.getByRole("navigation", { name: "주 메뉴" });
  await expect(page.getByRole("navigation", { name: "작업 단계" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "보안 분석 대시보드" })).toBeVisible();
  await expect(page.getByRole("button", { name: "프로젝트 분석 시작" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "샘플 분석 실행", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "요약 지표" })).toHaveCount(0);
  await steps.getByRole("button", { name: "에이전트 스킬" }).click();
  await expect(page).toHaveURL(/#\/skills$/);
  await expect(page.getByRole("region", { name: "에이전트 스킬" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "첫 실행 설정" })).toHaveCount(0);
  await steps.getByRole("button", { name: "결과 확인" }).click();
  await expect(page).toHaveURL(/#\/results$/);
  await expect(steps.getByRole("button", { name: "결과 확인" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "요약 지표" })).toContainText("분석 결과 없음");
  await expect(page.getByRole("region", { name: "실행 증거" })).toContainText("실행 증거 없음");
  await expect(page.getByRole("region", { name: "실행 증거" }).locator("article")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "에이전트 스킬" })).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/#\/skills$/);
  await expect(page.getByRole("region", { name: "에이전트 스킬" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("region", { name: "요약 지표" })).toContainText("분석 결과 없음");
  await page.reload();
  await expect(page.getByRole("region", { name: "요약 지표" })).toBeVisible();
  expect(runRequests).toHaveLength(0);
});

test("fixture 서버에서도 프로젝트 분석을 시작하지 않고 안내를 보여 준다", async ({ page }) => {
  await page.goto("/#/project");
  await expect(page.getByText("프로젝트 분석을 시작하려면 서버를 workspace 모드로 실행하세요")).toBeVisible();
  await expect(page.getByRole("button", { name: "프로젝트 분석", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "샘플 분석 실행", exact: true })).toHaveCount(0);
});

test("360px 모바일 폭에서 단계 화면이 가로 오버플로 없이 렌더된다", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/#/results");

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
