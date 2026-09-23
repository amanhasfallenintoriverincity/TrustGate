# 보안 경계

TrustGate는 LLM이 확정 판정을 내리지 않도록 실행과 보고의 책임을 분리합니다. 다음 경계는 구현 범위를 설명하며, 어떤 서비스든 자동으로 안전하다고 보증하지 않습니다.

1. **LLM은 가설만 생성하고 판정하지 않습니다.** `planner.ts`가 변경 줄에서 검증 가능한 `AnalysisPlan` 후보를 받고 `packages/contracts`의 Zod 계약 및 근거 검사를 거칩니다. `verdict.ts`는 실제 실행 결과의 `CONFIRMED`와 `BLOCKED`를 비교해 `FIXED`를 결정합니다. 오류나 미검증 결과는 안전 판정으로 올리지 않습니다.
2. **샌드박스에는 네트워크·API 키·OAuth·GitHub 쓰기 토큰을 전달하지 않습니다.** `sandbox-policy.ts`는 `--network none`, `--env-host=false`, `--unsetenv-all`, 프록시 비활성화, 읽기 전용 파일 시스템, 비특권 사용자, 리소스 제한을 지정합니다. 샌드박스 프로세스 환경은 `CONTAINERS_CONF`, `HOME`, `XDG_RUNTIME_DIR`, `PATH`만 허용하고, 컨테이너에는 `TARGET_MODE`, `HOME`, `NODE_ENV`, `PATH`만 전달합니다. 컨테이너에 호스트 자격 증명을 마운트하거나 `--env-file`로 주입하지 않습니다.
3. **테스트 DSL에서 shell·JavaScript·SQL 실행을 허용하지 않습니다.** `packages/contracts/src/index.ts`의 요청·단언 스키마는 유한한 형식만 받으며 `spec-runner.ts`가 HTTP 요청 및 상태 단언을 처리합니다. `security-plan.ts`도 LLM에 코드나 명령 대신 JSON 후보만 반환하도록 지시합니다. 프롬프트만을 안전 경계로 취급하지 않고 스키마·실행기에서 다시 검사합니다.
4. **Codex OAuth 연동은 비공식 커뮤니티 어댑터의 로컬 단일 사용자 선택 기능입니다.** 이 저장소의 서버 기본 fixture 모드에는 로그인이나 토큰이 필요하지 않습니다. 인증 정보를 샌드박스로 전달하거나 화면에 노출하지 마십시오. [제3자 고지](../THIRD_PARTY_NOTICES.md)는 이 어댑터의 출처와 라이선스를 프로젝트 자체 허가와 구분합니다.
5. **실서비스 세부 정보와 개인 식별 정보는 데모에 포함하지 않습니다.** `apps/demo-target`의 가상 아이템·계정과 `fixture-plan.json`의 재생 데이터만 설명합니다. 공개 문서, 예시 요청, 화면 캡처에 실서비스 식별자나 자격 증명을 넣지 마십시오.

## 격리 실행 및 로그

`SANDBOX_CONTAINERS_CONF`(`sandbox-policy.ts`)는 `env_host=false`, `mounts=[]`, `volumes=[]`, `http_proxy=false`, `read_only=true` 등의 Podman 기본값을 고정합니다. 실행기는 각 호출마다 제한된 권한의 임시 `containers.conf`를 생성해 `CONTAINERS_CONF`로 지정하고, 종료 시 정책에서 만든 고유 이름으로 컨테이너를 제거하고 `container exists`로 이름이 남아 있는지 확인합니다(`sandbox-runner.ts`). 컨테이너 구성을 비교하지는 않습니다. 이 설정은 호스트의 일반적인 Podman 환경값이 검사 대상에 흘러드는 것을 줄이며, `--network none`은 컨테이너의 외부 네트워크를 차단합니다. 반면 이미지 빌드는 기반 이미지 및 의존성 입수에 네트워크가 필요할 수 있으므로 실행 단계의 오프라인 정책과 혼동하지 마십시오.

`redaction.ts`는 출력 직전에 로그의 자격 증명 패턴을 지우고 처리 실패 시 원문 대신 고정 실패 기록을 남깁니다. `server.ts`는 Fastify 기본 로거를 끄고 비민감 메타데이터만 로그에 전달하며, 오류 응답도 고정 문구로 제한합니다. 회귀 테스트(`redaction.test.ts`, `sandbox-policy.test.ts`, `sandbox-runner.test.ts`)는 누출 및 정책 경로를 검사합니다. 이것은 모든 가능한 비밀 문자열에 대한 절대적 보장을 뜻하지 않으므로 민감 데이터를 입력·예시·로그에 넣지 마십시오.

`workspace` 저장소 경로는 허용 루트의 실경로로 검사하고 실행 직전 재확인합니다(`server.ts`). 두 검사와 첫 파일 접근 사이의 시간차는 남아 있으므로, 임의 사용자의 저장소를 공유 호스트에서 안전하게 검사하는 범용 서비스로 제시하지 않습니다. [구조](ARCHITECTURE.md)에서 fixture와 작업 공간 실행의 차이를 확인합니다.
