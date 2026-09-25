import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * 브라우저 E2E 설정: 대시보드가 실제 API와 왕복하는 경로만 검증합니다.
 *
 * - vite dev(5173)가 `/api`를 오케스트레이터(8787)로 프록시합니다(vite.config.ts).
 * - 오케스트레이터는 fixture 모드로 띄웁니다: 샘플 실행은 LLM이나 컨테이너 없이
 *   `fixture-plan.json`을 재생합니다. 설정 연결 테스트만 일회성 로컬 가짜 제공자를 호출합니다.
 * - 두 서버는 로컬·CI 구분 없이 **항상 Playwright가 기동하고 종료합니다**(`reuseExistingServer: false`).
 *   그래서 점유된 포트를 만나면 "이미 사용 중"으로 즉시 실패하고, 다른 코드 트리나 다른 설정으로
 *   떠 있는 서버를 조용히 검증하는 일이 없습니다. 정상 실행이 끝나면 포트도 함께 비워집니다.
 * - 두 서버가 쓸 ambient 값을 여기서 고정합니다. Playwright는 webServer `env`를
 *   `{...process.env, ...env}`로 병합하므로, 명시하지 않은 값은 ambient 환경에서 그대로 새어
 *   들어갑니다. 그래서 web의 `TRUSTGATE_DEV_ORIGIN`은 8787로, 오케스트레이터의 `TRUSTGATE_HOST`는
 *   127.0.0.1로 적습니다. 후자가 없으면 ambient `TRUSTGATE_HOST`가 살아 있을 때 오케스트레이터가
 *   다른 주소에 바인드하고(예: `127.0.0.2:8787`), Playwright는 여기 적힌 `url`(`127.0.0.1:8787`)만
 *   확인하므로 60초를 기다린 끝에 실패합니다 — 게이트가 검증하는 주소와 실제 서버 주소가 갈라집니다.
 * - 설정 저장소는 실행마다 새로 만든 비공개 XDG_CONFIG_HOME 아래에만 존재합니다.
 *   Playwright의 plugin teardown은 webServer teardown 뒤에 역순으로 실행되므로 종료 전에
 *   지우지 않습니다. `process.on('exit')` 비동기 삭제는 사용하지 않습니다.
 */
const configHome = join(process.env.TMPDIR || tmpdir(), `trustgate-e2e-${randomUUID()}`);
const previousIsolationFlag = process.env.TRUSTGATE_E2E_ISOLATED;
let createdConfigHome = false;

const config = defineConfig({
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
      // Ambient provider fallback cannot turn a fresh E2E config into an already-configured UI.
      command: "cd ../.. && env -u TRUSTGATE_LLM_BASE_URL -u TRUSTGATE_LLM_MODEL -u TRUSTGATE_SANDBOX_IMAGE -u TRUSTGATE_LLM_KIND -u TRUSTGATE_LLM_API_KEY_ENV node apps/orchestrator/dist/main.js",
      url: "http://127.0.0.1:8787/health",
      env: {
        TRUSTGATE_MODE: "fixture",
        // ambient `TRUSTGATE_HOST`가 살아 있으면 오케스트레이터가 아래 `url`과 다른 주소에
        // 바인드합니다. 위 주석의 DEV_ORIGIN과 같은 이유로 여기서 127.0.0.1로 고정합니다.
        TRUSTGATE_HOST: "127.0.0.1",
        TRUSTGATE_PORT: "8787",
        XDG_CONFIG_HOME: configHome,
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

// Register this lifecycle plugin before Playwright appends webServer plugins. Their LIFO
// teardown stops both servers first; then this deletes exactly the directory we generated.
// No directory is created for --list, and even startup/test failures run plugin teardown.
export default Object.assign(config, {
  "@playwright/test": {
    plugins: [() => ({
      name: "isolated-e2e-config",
      setup: async () => {
        await mkdir(configHome, { mode: 0o700 });
        createdConfigHome = true;
        process.env.TRUSTGATE_E2E_ISOLATED = "1";
      },
      teardown: async () => {
        if (previousIsolationFlag === undefined) delete process.env.TRUSTGATE_E2E_ISOLATED;
        else process.env.TRUSTGATE_E2E_ISOLATED = previousIsolationFlag;
        if (createdConfigHome) await rm(configHome, { recursive: true, force: true });
      },
    })],
  },
});
