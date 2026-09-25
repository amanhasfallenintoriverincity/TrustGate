# TrustGate

LLM은 가설만, 판정은 격리 컨테이너의 결정론적 실행으로 내립니다. TrustGate는 신뢰 경계에서 발생하는 가격·소유권 변조 등의 비즈니스 로직 취약점을 수정 전후의 HTTP 응답과 상태 변화로 비교합니다.

## 5분 데모: fixture 모드

Node.js 24 이상과 npm을 준비합니다. 아래 경로는 유료 API 키와 Podman 없이 기록된 fixture 보고서를 재생합니다. **fixture 실행은 컨테이너를 실제로 실행하지 않습니다.** 터미널에서 저장소 루트를 작업 디렉터리로 삼습니다.

```bash
npm ci
npm run build
```

서버를 시작합니다. 빌드된 대시보드와 API를 한 서버가 `127.0.0.1:8787`에서 제공합니다.

```bash
npm start
```

브라우저에서 <http://127.0.0.1:8787/>을 엽니다. 첫 화면은 분석 대시보드입니다. **연결 설정**, **프로젝트 선택/분석**, **에이전트 스킬**, **결과 확인**은 왼쪽 메뉴에서 이동할 수 있습니다. 저장된 fixture 응답은 API를 직접 호출해 확인할 수 있습니다.

**연결 설정**에서 OpenAI-compatible·Anthropic-compatible 엔드포인트 또는 비공식 Codex OAuth를 선택하고 모델과 샌드박스 이미지 이름을 저장합니다. API 키 방식은 **API 인증 정보**를 별도 서버 저장소에 보관하며, 키 값을 설정 응답에 넣지 않습니다. OAuth는 로컬 인증 저장소를 사용합니다. **연결 테스트**는 저장한 설정으로 짧은 모델 요청을 실제 전송하므로 사용량이 발생할 수 있습니다.

```bash
curl -i -H 'Content-Type: application/json' -d '{"source":"fixture"}' http://127.0.0.1:8787/api/runs
```

실측한 fixture 응답은 `HTTP/1.1 201 Created`, `source: fixture`, 검토 파일 2건, 가설 2건, 수정 전 `CONFIRMED` 3건, 수정 후 `BLOCKED` 3건, 전체 `regressionVerdict: FIXED`입니다. `negative-price` 사례에서는 기대 HTTP 400 대신 수정 전 실제 HTTP 200 및 `balance` 변화 `+100`을 기록하고 수정 후 차단합니다. 이 응답은 API·CLI 전용 fixture 경로의 결과이며 대시보드 화면에 자동으로 채워지지 않습니다. 임의로 생성되는 `runId`는 매번 달라집니다. 종료할 때는 서버 터미널에서 Ctrl+C를 누릅니다.

> `npm start`는 빌드된 `apps/orchestrator/dist/main.js`를 실행합니다. 코드를 변경했다면 먼저 `npm run build`를 다시 실행하세요.

## 허용한 프로젝트의 분석과 코딩 에이전트 스킬

프로젝트 분석을 하려면 Linux의 `bubblewrap`(`/usr/bin/bwrap`), rootless Podman, 미리 빌드한 샌드박스 이미지, LLM 연결이 필요합니다. OCR은 검사 대상의 Git 메타데이터를 격리된 읽기 전용 환경에서 수집하며, `bubblewrap`이 없으면 분석을 중단합니다. 설정을 저장한 뒤 fixture 서버를 종료하고, **검사하도록 허용한 프로젝트의 절대 경로**를 서버 시작 전에 지정합니다. 인증 정보는 대시보드에서 별도로 저장하며 키 값을 명령줄에 적지 않습니다.

```bash
TRUSTGATE_MODE=workspace TRUSTGATE_WORKSPACE_ROOT=/absolute/path/to/project node apps/orchestrator/dist/main.js
```

서버와 대시보드는 `127.0.0.1`로만 열고, 대시보드의 **프로젝트 분석 시작**에서 경로를 비우면 지정한 허용 루트를, 상대 경로를 적으면 그 하위 디렉터리를 대상으로 합니다. 서버는 루트 밖 경로를 거부합니다. `workspace` 모드에서 `TRUSTGATE_WORKSPACE_ROOT`가 없거나 유효한 절대 디렉터리가 아니면 서버가 시작되지 않습니다. 서버가 시작된 뒤 설정을 저장해도 같은 프로세스의 다음 workspace 요청에 적용됩니다. 단, fixture로 시작한 서버를 workspace 모드로 바꾸려면 다시 시작해야 합니다.

서버를 workspace 모드로 시작한 다음, 대시보드의 **에이전트 스킬**에서 필요한 에이전트의 **스킬 설치** 버튼을 누를 수 있습니다. 서버에 고정한 허용 루트에만 설치되며, 기존 파일은 덮어쓰지 않습니다. 별도 CLI로 설치하려면 TrustGate 저장소 루트에서 다음 명령을 실행합니다.

```bash
node bin/trustgate.mjs skill install --agent codex --project /absolute/path/to/project
node bin/trustgate.mjs skill install --agent claude --project /absolute/path/to/project
node bin/trustgate.mjs skill install --agent cursor --project /absolute/path/to/project
node bin/trustgate.mjs skill install --agent hermes --project /absolute/path/to/project
hermes skills trust /absolute/path/to/project
```

각 스킬은 각각 `.agents/skills/`, `.claude/skills/`, `.cursor/skills/`, `.hermes/skills/` 아래에 설치됩니다. 마지막 `hermes skills trust`는 Hermes를 실제로 사용하는 경우에만, 사용자가 검토 후 별도로 실행합니다. 스킬은 서버를 시작하거나 권한을 자동 부여하지 않으며, 이 TrustGate 체크아웃의 CLI 절대 경로를 기록하므로 CLI 파일을 이동하면 다시 설치해야 합니다. 서버가 켜진 상태에서는 `node bin/trustgate.mjs health`, `node bin/trustgate.mjs scan --fixture`, `node bin/trustgate.mjs scan --root`(허용 루트 자체), `node bin/trustgate.mjs scan --repo subdir`(그 하위 경로)를 사용할 수 있습니다. `--fixture`, `--root`, `--repo` 중 하나만 선택합니다. CLI 기본 제한 시간은 180초이며, 느린 분석은 `--timeout-ms 300000`까지 지정할 수 있습니다. 에이전트는 검사할 프로젝트의 사용자 승인을 먼저 확인해야 합니다.

현재 workspace 파이프라인은 대상 프로젝트에서 변경 파일과 가설을 수집하지만, 샌드박스 실행기는 TrustGate의 **고정 데모 타깃**을 사용합니다. 따라서 임의의 외부 서비스에 대한 취약점 재현을 보증하지 않으며, `UNVERIFIED`/오류 결과를 안전 판정으로 해석해서는 안 됩니다. 샘플 결과와 workspace 결과도 서로 구분해 표시합니다.

## 별도 경로: rootless Podman 실실행 검증

이 경로는 fixture 화면과 다릅니다. rootless Podman이 동작하는 환경에서 동일한 이미지에 `TARGET_MODE=vulnerable/patched`를 각각 지정해 같은 테스트 명세를 실행하고 기록된 판정과 대조합니다. 저장소 루트에서 순서대로 실행하며 개발 서버가 8787/5173 포트를 점유 중이라면 먼저 종료합니다.

```bash
podman build -f apps/demo-target/Containerfile.sandbox -t localhost/trustgate-target:sandbox .
RUN_PODMAN_E2E=1 npm test -w @trustgate/orchestrator
```

전체 오케스트레이터 스위트를 실행하며 샌드박스 E2E가 포함됩니다. 현재 개발 브랜치에서는 `tests 657`, `pass 657`, `fail 0`, `skipped 0`을 확인했습니다. 샌드박스 이미지 또는 rootless Podman이 준비되지 않으면 E2E는 성공하지 않습니다. 오래된 명령의 `-- sandbox.e2e` 위치 인자는 테스트 필터가 아니므로 사용하지 않습니다.

## 확인 및 문서

```bash
npm run check
```

- [데모 단계와 브라우저 E2E](docs/DEMO.md)
- [데이터 흐름과 모듈](docs/ARCHITECTURE.md)
- [보안 경계와 제약](docs/SECURITY.md)
- [제3자 고지](THIRD_PARTY_NOTICES.md)

제3자 패키지의 Apache-2.0 고지는 TrustGate 저장소 자체의 라이선스 선언이 아닙니다. 현재 저장소에는 프로젝트 자체의 `LICENSE` 파일이 없으므로 제3자 사용 허가를 프로젝트 전체의 사용 허가로 간주하지 마십시오.
