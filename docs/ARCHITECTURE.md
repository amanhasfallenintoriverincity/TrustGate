# TrustGate 구조

LLM 출력은 실행 후보일 뿐입니다. 오케스트레이터가 후보를 검증하고, 수정 전후의 실행 결과를 비교해 판정을 만듭니다. 전체 작업 공간 분석의 데이터 흐름은 다음과 같습니다.

```text
OCR file/rule selection → selected Git diff → LLM AnalysisPlan candidate
→ Zod fail-closed validation → offline Podman execution
→ deterministic state comparison → regression report → inline dashboard
```

| 단계 | 구현 위치 | 입력과 출력 |
|---|---|---|
| 파일·규칙 선택 | `apps/orchestrator/src/ocr-adapter.ts` | OpenCodeReview의 preview/rule 결과를 읽고 선택 파일과 규칙 그룹이 정확히 대응하는지 확인합니다. |
| Git diff | `apps/orchestrator/src/diff-collector.ts` | 선택된 파일의 변경 내용을 수집하고 크기를 제한합니다. |
| 가설 생성 | `apps/orchestrator/src/planner.ts`, `apps/orchestrator/src/prompts/security-plan.ts`, `llm-gateway/src/` | 변경 줄에 연결된 보안 가설과 한정된 HTTP 테스트 명세인 `AnalysisPlan` 후보를 요청합니다. |
| 계약 검증 | `packages/contracts/src/index.ts` | Zod 스키마로 계획·실행 결과를 검증하고 부적합한 출력을 거부합니다. |
| 격리 실행 | `apps/orchestrator/src/sandbox-policy.ts`, `apps/orchestrator/src/sandbox-runner.ts`, `apps/demo-target/src/sandbox-main.ts` | 정책이 제한한 Podman에서 단일 이미지에 `TARGET_MODE=vulnerable/patched`를 각각 지정해 같은 계획을 실행합니다. |
| 상태 비교 | `apps/orchestrator/src/spec-runner.ts`, `apps/orchestrator/src/verdict.ts` | HTTP 응답, 요청 전후 상태 변화의 예상값과 실제값을 비교하고 `CONFIRMED → BLOCKED`이면 `FIXED`로 분류합니다. |
| 보고·API | `apps/orchestrator/src/report.ts`, `apps/orchestrator/src/server.ts` | 실행 결과와 회귀 판정을 보고서로 묶어 `/api/runs` 응답에 담습니다. |
| 화면 | `apps/web/src/App.tsx`, `apps/web/src/lib/api.ts`, `apps/orchestrator/src/server.ts` | 빌드된 대시보드와 로컬 API를 `127.0.0.1:8787`에서 함께 제공하고, 가설·테스트별 증거와 판정을 페이지 안에 그립니다. |
| 첫 실행 설정 | `apps/web/src/Setup.tsx`, `apps/orchestrator/src/setup-store.ts`, `apps/orchestrator/src/server.ts` | 비밀이 아닌 제공자 설정과 API 인증 정보를 별도 파일에 보관합니다. OAuth는 별도 로컬 인증 저장소를 사용하며 연결 테스트는 사용자가 따로 실행합니다. |
| 에이전트 연동 | `apps/web/src/lib/skills.ts`, `apps/orchestrator/src/server.ts`, `bin/trustgate.mjs`, `skills/trustgate/SKILL.md` | workspace 모드에서 사용자가 에이전트별 설치 버튼을 눌렀을 때만 서버에 고정한 허용 루트에 스킬을 설치합니다. CLI는 로컬 서버에 fixture 또는 허용된 workspace 실행을 요청합니다. |

`workspace` 요청은 저장소 경로를 허용 루트 내부의 실경로로 검증한 뒤 OCR, diff, 계획, 샌드박스, 보고서 경로를 실행합니다. 이 경로에는 LLM 연결과 Podman 이미지 설정이 추가로 필요합니다(`apps/orchestrator/src/server.ts`). 대시보드는 이 경로만 실행하며, 실행 전 결과 화면은 비어 있습니다. `fixture`는 `apps/orchestrator/src/fixture-plan.json`의 검증된 스냅샷을 재생해 같은 보고서 구조를 만들지만, 대시보드 버튼이 아니라 API·CLI 경로에서만 호출합니다. fixture는 OCR·LLM·컨테이너를 호출하지 않으므로 이 응답을 새 워크스페이스의 실시간 컨테이너 검사 결과로 소개하지 않습니다.

외부 프로젝트의 허용 루트는 서버 시작 시 `TRUSTGATE_WORKSPACE_ROOT`로 고정하며 요청이나 스킬 설치가 루트를 변경하지 않습니다. 현재 샌드박스 이미지는 TrustGate 데모 타깃의 취약/수정 모드를 실행합니다. 다른 저장소에서 수집한 가설의 실행 결과를 그 서비스 자체의 재현 증거로 일반화하지 마십시오.

컨테이너 실실행 여부는 [데모 안내](DEMO.md)의 별도 rootless Podman E2E 경로에서 확인합니다. 실행 경계와 잔여 위험은 [보안 안내](SECURITY.md)를 참고합니다.
