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
| 화면 | `apps/web/src/App.tsx`, `apps/web/src/lib/api.ts` | API 응답의 가설·테스트별 증거와 판정을 페이지 안에 그립니다. |

`workspace` 요청은 저장소 경로를 허용 루트 내부의 실경로로 검증한 뒤 OCR, diff, 계획, 샌드박스, 보고서 경로를 실행합니다. 이 경로에는 LLM 연결과 Podman 이미지 설정이 추가로 필요합니다(`apps/orchestrator/src/server.ts`). 현재 대시보드의 **샘플 분석 실행** 버튼은 이 경로가 아니라 `{ "source": "fixture" }` 요청을 보냅니다. `fixture`는 `apps/orchestrator/src/fixture-plan.json`의 검증된 스냅샷을 재생하여 같은 보고서 구조를 생성하며, OCR·LLM·컨테이너를 호출하지 않습니다. 따라서 데모 화면의 판정을 새 워크스페이스에 대한 실시간 컨테이너 검사 결과로 소개하지 않습니다.

컨테이너 실실행 여부는 [데모 안내](DEMO.md)의 별도 rootless Podman E2E 경로에서 확인합니다. 실행 경계와 잔여 위험은 [보안 안내](SECURITY.md)를 참고합니다.
