import { defineConfig } from "@playwright/test";

/**
 * 브라우저 E2E 설정: 대시보드가 실제 API와 왕복하는 경로만 검증합니다.
 *
 * - vite dev(5173)가 `/api`를 오케스트레이터(8787)로 프록시합니다(vite.config.ts).
 * - 오케스트레이터는 fixture 모드로 띄웁니다: LLM도 컨테이너도 네트워크도 쓰지 않고
 *   `fixture-plan.json`을 재생하므로 판정이 실행마다 같습니다.
 * - 두 서버는 Playwright가 직접 기동/종료합니다. 테스트가 끝나면 포트도 함께 비워집니다.
 */
export default defineConfig({
  testDir: "./e2e",
  // 오케스트레이터는 동시 실행 1건만 받습니다(두 번째 요청은 409). 파일이 하나라 기본값도
  // 순차 실행이지만, 워커 수를 고정해 이 전제가 설정 변경에 흔들리지 않게 합니다.
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
  },
  webServer: [
    {
      // config가 apps/web에 있어 기본 cwd가 apps/web입니다 → 루트 기준 명령은 cd ../..로 맞춥니다.
      command: "cd ../.. && node apps/orchestrator/dist/main.js",
      url: "http://127.0.0.1:8787/health",
      env: {
        TRUSTGATE_MODE: "fixture",
        TRUSTGATE_PORT: "8787",
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "cd ../.. && npm run dev -w @trustgate/web -- --port 5173 --strictPort",
      url: "http://127.0.0.1:5173/",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
