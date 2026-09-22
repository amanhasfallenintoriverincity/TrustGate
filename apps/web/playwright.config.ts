import { defineConfig } from "@playwright/test";

/**
 * 브라우저 E2E 설정: 대시보드가 실제 API와 왕복하는 경로만 검증합니다.
 *
 * - vite dev(5173)가 `/api`를 오케스트레이터(8787)로 프록시합니다(vite.config.ts).
 * - 오케스트레이터는 fixture 모드로 띄웁니다: LLM도 컨테이너도 네트워크도 쓰지 않고
 *   `fixture-plan.json`을 재생하므로 판정이 실행마다 같습니다.
 * - 두 서버는 로컬·CI 구분 없이 **항상 Playwright가 기동하고 종료합니다**(`reuseExistingServer: false`).
 *   그래서 점유된 포트를 만나면 "이미 사용 중"으로 즉시 실패하고, 다른 코드 트리나 다른 설정으로
 *   떠 있는 서버를 조용히 검증하는 일이 없습니다. 정상 실행이 끝나면 포트도 함께 비워집니다.
 * - web 서버의 `TRUSTGATE_DEV_ORIGIN`은 여기서 8787로 고정합니다. Playwright는 webServer `env`를
 *   `{...process.env, ...env}`로 병합하므로, 이 값을 명시하지 않으면 ambient 값이 vite로 새어
 *   들어가 `/api`가 다른 오케스트레이터를 향하고 게이트가 다른 서버를 검증하게 됩니다.
 */
export default defineConfig({
  testDir: "./e2e",
  // 오케스트레이터는 동시 실행 1건만 받습니다(두 번째 요청은 409). 파일이 하나라 기본값도
  // 순차 실행이지만, 워커 수를 고정해 이 전제가 설정 변경에 흔들리지 않게 합니다.
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    // 실패한 실행만 흔적을 남깁니다(통과 실행은 아티팩트 0건). `test-results/`는 gitignore 대상입니다.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
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
      // 점유된 포트(개발용 오케스트레이터 등)는 재사용하지 않고 즉시 실패합니다.
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        "cd ../.. && npm run dev -w @trustgate/web -- --host 127.0.0.1 --port 5173 --strictPort",
      url: "http://127.0.0.1:5173/",
      // ambient 값과 무관하게 프록시 대상이 방금 띄운 오케스트레이터로 고정됩니다.
      env: {
        TRUSTGATE_DEV_ORIGIN: "http://127.0.0.1:8787",
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
