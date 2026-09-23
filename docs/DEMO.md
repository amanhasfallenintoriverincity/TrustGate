# 데모 재현 안내

대시보드의 샘플 실행은 저장된 fixture를 재생합니다. 실제 새 코드를 LLM으로 분석하거나 Podman 컨테이너를 실행하지 않습니다. 격리 컨테이너의 결정론적 실행은 아래의 별도 E2E 경로로 확인합니다.

## 경로 1: API 키·Podman 없이 화면 확인

저장소 루트에서 Node.js 24 이상을 사용합니다. 8787·5173 포트가 비어 있는지 먼저 확인하고 순서대로 실행합니다.

```bash
npm ci
npm run build
```

첫 번째 터미널:

```bash
node apps/orchestrator/dist/main.js
```

두 번째 터미널:

```bash
npm run dev -w @trustgate/web
```

브라우저에서 <http://127.0.0.1:5173/>을 열어 **샘플 분석 실행**을 누릅니다. 실행 전 **샘플 값**과 실행 후 **실제 실행 결과**를 구분합니다. 종료는 각 터미널의 Ctrl+C로 합니다. API만 확인할 때는 서버가 켜진 상태에서 다음을 실행합니다.

```bash
curl -i -H 'Content-Type: application/json' -d '{"source":"fixture"}' http://127.0.0.1:8787/api/runs
```

실측 응답의 상태 줄은 `HTTP/1.1 201 Created`입니다. `source`는 `fixture`이고, 보고서에는 `reviewedFiles` 2개, `hypotheses` 2개, `vulnerableResults`의 `CONFIRMED` 3개, `patchedResults`의 `BLOCKED` 3개, `regressionVerdict: FIXED`가 들어 있습니다. `runId`는 호출마다 새로 만들어져 고정 예시로 제시하지 않습니다.

대시보드에서 첫 증거 카드를 확인합니다. `price-authority / negative-price`는 `POST /api/purchase`로 음수 가격을 보냅니다. 수정 전에는 기대 상태 400과 달리 실제 200, 기대 잔액 변화 0과 달리 실제 100이라서 `CONFIRMED`입니다. 수정 후에는 같은 단언을 충족해 `BLOCKED`이며, 조합 판정은 `FIXED`입니다. 다른 두 시나리오는 낮은 가격과 타인 소유 아이템의 양도입니다. 숫자와 판정은 `apps/orchestrator/src/fixture-plan.json`을 서버로 재생한 응답을 기준으로 적었습니다.

> 기존 계획서의 오케스트레이터 `dev` 스크립트는 현재 없습니다. 빌드 후 `node apps/orchestrator/dist/main.js`를 사용합니다. 이 수정은 프로그램 코드를 변경하지 않습니다.

## 경로 2: rootless Podman으로 실제 취약/수정 컨테이너 검증

Podman이 rootless로 동작해야 합니다. 다음 이미지와 태그는 E2E가 검사하는 이름과 동일합니다. 빌드가 의존성이나 기반 이미지를 내려받을 때는 네트워크가 필요할 수 있습니다. 컨테이너 실행 자체에는 `--network none` 정책이 적용됩니다.

```bash
podman build -f apps/demo-target/Containerfile.sandbox -t localhost/trustgate-target:sandbox .
RUN_PODMAN_E2E=1 npm test -w @trustgate/orchestrator
```

실측한 이미지 빌드는 `Successfully tagged localhost/trustgate-target:sandbox`로 종료했고, 전체 테스트는 `tests 603`, `pass 603`, `fail 0`, `skipped 0`이었습니다. 이 실행의 샌드박스 E2E는 실제 컨테이너 결과를 fixture 스냅샷의 기대값과 항목별로 비교합니다. 기존 계획서에 있던 `-- sandbox.e2e` 위치 인자는 테스트 선택 필터가 아니므로 붙이지 않습니다.

## 자동화된 화면 왕복 검증

서버를 수동으로 띄웠다면 먼저 종료해 8787·5173 포트를 비웁니다. Playwright는 두 서버를 직접 띄우고 종료하며, 오케스트레이터 빌드 산출물을 필요로 합니다.

```bash
npm run build -w @trustgate/orchestrator
npm run e2e -w @trustgate/web
```

실측: `2 passed`. 첫 테스트는 버튼에서 API까지의 요청과 판정을, 두 번째 테스트는 모바일 폭의 가로 넘침을 확인합니다. 브라우저 실행 파일이 없는 환경에서는 Playwright 설치가 별도로 필요할 수 있으며, 그 환경의 E2E 성공은 여기서 보증하지 않습니다.

[README로 돌아가기](../README.md) · [보안 경계](SECURITY.md)
