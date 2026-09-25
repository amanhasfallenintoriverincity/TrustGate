# 데모 재현 안내

대시보드는 `workspace` 모드에서만 실제 프로젝트를 분석합니다. 실행 전 결과 화면에는 예시 수치를 채우지 않습니다. 저장된 fixture는 API·CLI 경로에서만 재생하며 격리 컨테이너의 결정론적 실행은 아래의 별도 E2E 경로로 확인합니다.

## 경로 1: API 키·Podman 없이 화면 확인

저장소 루트에서 Node.js 24 이상을 사용합니다. 8787 포트가 비어 있는지 확인하고 빌드한 뒤 서버를 시작합니다.

```bash
npm ci
npm run build
npm start
```

브라우저에서 <http://127.0.0.1:8787/>을 엽니다. 첫 화면은 보안 분석 대시보드이며 왼쪽 메뉴에서 **연결 설정**, **프로젝트 선택/분석**, **에이전트 스킬**, **결과 확인**으로 이동합니다. 종료는 서버 터미널에서 Ctrl+C를 누릅니다. 저장된 fixture 응답은 API로 직접 확인합니다.

**연결 설정** 화면에서 제공자 설정을 저장합니다. API 키 방식은 마스킹된 입력과 별도의 **인증 정보 저장** 버튼으로 서버 저장소에 보관합니다. 비공식 Codex OAuth는 별도 로컬 인증 흐름을 사용합니다. **연결 테스트**는 실제 제공자 요청을 보내므로 사용량과 데이터 처리 조건을 확인한 뒤 누릅니다.

```bash
curl -i -H 'Content-Type: application/json' -d '{"source":"fixture"}' http://127.0.0.1:8787/api/runs
```

실측 응답의 상태 줄은 `HTTP/1.1 201 Created`입니다. `source`는 `fixture`이고, 보고서에는 `reviewedFiles` 2개, `hypotheses` 2개, `vulnerableResults`의 `CONFIRMED` 3개, `patchedResults`의 `BLOCKED` 3개, `regressionVerdict: FIXED`가 들어 있습니다. `runId`는 호출마다 새로 만들어져 고정 예시로 제시하지 않습니다.

fixture 응답의 첫 증거는 `price-authority / negative-price`가 `POST /api/purchase`로 음수 가격을 보냅니다. 수정 전에는 기대 상태 400과 달리 실제 200, 기대 잔액 변화 0과 달리 실제 100이라서 `CONFIRMED`입니다. 수정 후에는 같은 단언을 충족해 `BLOCKED`이며, 조합 판정은 `FIXED`입니다. 다른 두 시나리오는 낮은 가격과 타인 소유 아이템의 양도입니다. 숫자와 판정은 `apps/orchestrator/src/fixture-plan.json`을 서버로 재생한 응답을 기준으로 적었습니다.

> 기존 계획서의 오케스트레이터 `dev` 스크립트는 현재 없습니다. 빌드 후 `node apps/orchestrator/dist/main.js`를 사용합니다. 이 수정은 프로그램 코드를 변경하지 않습니다.

## 경로 2: rootless Podman으로 실제 취약/수정 컨테이너 검증

Podman이 rootless로 동작해야 합니다. 다음 이미지와 태그는 E2E가 검사하는 이름과 동일합니다. 빌드가 의존성이나 기반 이미지를 내려받을 때는 네트워크가 필요할 수 있습니다. 컨테이너 실행 자체에는 `--network none` 정책이 적용됩니다.

```bash
podman build -f apps/demo-target/Containerfile.sandbox -t localhost/trustgate-target:sandbox .
RUN_PODMAN_E2E=1 npm test -w @trustgate/orchestrator
```

현재 개발 브랜치에서 rootless Podman E2E를 포함한 전체 오케스트레이터 테스트는 `tests 657`, `pass 657`, `fail 0`, `skipped 0`이었습니다. 이 실행의 샌드박스 E2E는 실제 컨테이너 결과를 fixture 스냅샷의 기대값과 항목별로 비교합니다. 기존 계획서에 있던 `-- sandbox.e2e` 위치 인자는 테스트 선택 필터가 아니므로 붙이지 않습니다.

## 자동화된 화면 왕복 검증

서버를 수동으로 띄웠다면 먼저 종료해 8787·5173 포트를 비웁니다. Playwright는 두 서버를 직접 띄우고 종료하며, 오케스트레이터 빌드 산출물을 필요로 합니다.

```bash
npm run build -w @trustgate/orchestrator
npm run e2e -w @trustgate/web
```

실측 기준은 단계 전환·URL 복원, workspace 모드 안내, 360px 가로 넘침, 첫 실행 설정 조회·저장과 격리된 로컬 가짜 제공자 연결 테스트입니다. 실제 자격 증명이나 유료 API는 사용하지 않습니다. 브라우저 실행 파일이 없는 환경에서는 Playwright 설치가 별도로 필요할 수 있으며, 그 환경의 E2E 성공은 여기서 보증하지 않습니다.

[README로 돌아가기](../README.md) · [보안 경계](SECURITY.md)
