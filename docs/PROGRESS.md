# TrustGate 구현 진행 현황

계획된 Task 1–19의 로컬 `deepseek` 브랜치 구현을 마쳤습니다. 아래 SHA는 각 구간의 대표 구현 커밋이며, 후속 보완 커밋도 브랜치 기록에 남아 있습니다.

| 구간 | 완료한 작업 | 대표 커밋 SHA |
|---|---|---|
| Task 1–4 | npm workspace, 검증 계약, 합성 상점의 상태 모델·HTTP API | `b734c7d`, `c8df27a`, `00d6b38`, `8c0e4a1` |
| Task 5–7 | OpenCodeReview 위임 입력, 제한된 Git diff 수집, LLM 테스트 명세 후보 | `ba6ad0c`, `225f2cd`, `d449162` |
| Task 8–11 | 제한된 테스트 DSL 실행, rootless Podman 격리·실행, 수정 전후 회귀 판정 | `a4cef6a`, `499f23e`, `a961024`, `f1bc273` |
| Task 12–14 | 실행 API·fixture 재생, 인라인 대시보드와 API 연결 | `eb70e91`, `a84c727`, `43e5658` |
| Task 15–17 | 실제 격리 컨테이너 회귀 E2E, 브라우저 E2E, 출력 비밀 정보 제거 | `2d07ff0`, `d1d1432`, `238548e` |
| Task 18 | 실행·보안·데모 문서 및 재현 명령 정리 | `c915bb0`, `cbed5f0` |
| Task 19 | 순차 릴리스 검증과 HTTP fixture 응답 보고서 고정 | `5c18c54` |

## 오케스트레이터 API

`apps/orchestrator/src/server.ts`의 라우트를 기준으로 정리했습니다.

| 엔드포인트 | 동작 |
|---|---|
| `GET /health` | `{ "ok": true }`를 반환합니다. |
| `POST /api/runs` | `source: "fixture"` 또는 허용된 `workspace` 요청을 받습니다. 성공 시 보고서와 새 `runId`를 HTTP 201로 반환합니다. fixture는 LLM 호출이나 컨테이너 실행 없이 저장된 데이터를 재생합니다. |
| `GET /api/runs/:runId` | 같은 서버 인스턴스의 메모리에 저장된 보고서를 HTTP 200으로 읽습니다. 없는 ID는 HTTP 404이며 영구 저장 API는 아닙니다. |

## 검증 기록과 남은 경계

`node scripts/verify-release.mjs`는 `npm ci` → `npm run check` → `podman build -f apps/demo-target/Containerfile.sandbox -t localhost/trustgate-target:sandbox .` → `RUN_PODMAN_E2E=1 npm test -w @trustgate/orchestrator` → `npm run e2e -w @trustgate/web` → `npm audit --omit=dev --workspaces`를 순서대로 실행하고 실패 시 중단합니다. 로컬 `5c18c54`에서 이 6단계 명령은 두 차례 모두 통과했습니다.

| 확인 항목 | 기록된 결과 |
|---|---|
| rootless Podman 실컨테이너를 포함한 오케스트레이터 전체 테스트 | 603/603 통과, 실패·건너뜀 0건 (`RUN_PODMAN_E2E=1 npm test -w @trustgate/orchestrator`) |
| Playwright 브라우저 E2E | 2/2 통과 (`npm run e2e -w @trustgate/web`) |
| 프로덕션 의존성 감사 | 취약점 0건 (`npm audit --omit=dev --workspaces`) |
| 릴리스 스크립트 단위 테스트 | 4/4 통과 (`node --test scripts/verify-release.test.mjs`) |
| 저장된 fixture 보고서 | 실제 `POST /api/runs` HTTP 201 응답을 저장했습니다. 새 응답과 최상위 임의 `runId`만 제외하고 일치하며, 수정 전 `CONFIRMED`, 수정 후 `BLOCKED`, 회귀 판정 `FIXED`입니다. |

계획 구현 작업: `[###################]` 19/19 완료(문서·릴리스 게이트 포함)입니다. 이 수치는 실제 유료 LLM을 사용하는 `workspace` 전 구간 통합 검증이나 배포 완료를 뜻하지 않습니다. 해당 연결은 검증하지 않았고, 브랜치도 원격에 게시하지 않았습니다. 기본 화면은 fixture 재생이며 실컨테이너 검증은 별도 E2E 명령으로 확인합니다.

재현 방법은 [README](../README.md)와 [데모 안내](DEMO.md), 경계는 [보안 문서](SECURITY.md), 저장된 실제 fixture 응답은 [데모 보고서](../artifacts/demo-report.json)를 참조하십시오.
