# TrustGate

LLM은 가설만, 판정은 격리 컨테이너의 결정론적 실행으로 내립니다. TrustGate는 신뢰 경계에서 발생하는 가격·소유권 변조 등의 비즈니스 로직 취약점을 수정 전후의 HTTP 응답과 상태 변화로 비교합니다.

## 5분 데모: fixture 모드

Node.js 24 이상과 npm을 준비합니다. 아래 경로는 유료 API 키와 Podman 없이 기록된 fixture 보고서를 재생합니다. **fixture 실행은 컨테이너를 실제로 실행하지 않습니다.** 터미널에서 저장소 루트를 작업 디렉터리로 삼습니다.

```bash
npm ci
npm run build
```

첫 번째 터미널에서 API 서버를 시작합니다. 기본 주소는 `127.0.0.1:8787`이고, 기본 모드는 `fixture`입니다.

```bash
node apps/orchestrator/dist/main.js
```

두 번째 터미널에서 대시보드를 시작합니다.

```bash
npm run dev -w @trustgate/web
```

브라우저에서 <http://127.0.0.1:5173/>을 열고 **샘플 분석 실행**을 누릅니다. 버튼은 `/api/runs`에 `{"source":"fixture"}`를 POST합니다. API를 직접 확인하려면 두 서버가 켜진 상태에서 다음 명령을 실행합니다.

```bash
curl -i -H 'Content-Type: application/json' -d '{"source":"fixture"}' http://127.0.0.1:8787/api/runs
```

실측한 fixture 응답은 `HTTP/1.1 201 Created`, `source: fixture`, 검토 파일 2건, 가설 2건, 수정 전 `CONFIRMED` 3건, 수정 후 `BLOCKED` 3건, 전체 `regressionVerdict: FIXED`입니다. `negative-price` 사례에서는 기대 HTTP 400 대신 수정 전 실제 HTTP 200 및 `balance` 변화 `+100`을 기록하고 수정 후 차단합니다. 화면의 **샘플 값**은 버튼을 누르기 전의 미실행 예시이며, 실행 후 **실제 실행 결과** 배지는 fixture 보고서의 재생 결과를 뜻합니다. 임의로 생성되는 `runId`는 매번 달라집니다. 종료할 때는 각 서버를 띄운 터미널에서 Ctrl+C를 누릅니다.

> 계획서에 기재된 오케스트레이터 `dev` 스크립트는 현재 패키지에 없어 실행되지 않습니다. 위의 빌드 후 `node apps/orchestrator/dist/main.js`가 실제 기동 명령입니다.

## 별도 경로: rootless Podman 실실행 검증

이 경로는 fixture 화면과 다릅니다. rootless Podman이 동작하는 환경에서 동일한 이미지에 `TARGET_MODE=vulnerable/patched`를 각각 지정해 같은 테스트 명세를 실행하고 기록된 판정과 대조합니다. 저장소 루트에서 순서대로 실행하며 개발 서버가 8787/5173 포트를 점유 중이라면 먼저 종료합니다.

```bash
podman build -f apps/demo-target/Containerfile.sandbox -t localhost/trustgate-target:sandbox .
RUN_PODMAN_E2E=1 npm test -w @trustgate/orchestrator
```

전체 오케스트레이터 스위트를 실행하며 샌드박스 E2E가 포함됩니다. 검증 당시 `tests 603`, `pass 603`, `fail 0`, `skipped 0`이었습니다. 샌드박스 이미지 또는 rootless Podman이 준비되지 않으면 E2E는 성공하지 않습니다. 오래된 명령의 `-- sandbox.e2e` 위치 인자는 테스트 필터가 아니므로 사용하지 않습니다.

## 확인 및 문서

```bash
npm run check
```

- [데모 단계와 브라우저 E2E](docs/DEMO.md)
- [데이터 흐름과 모듈](docs/ARCHITECTURE.md)
- [보안 경계와 제약](docs/SECURITY.md)
- [제3자 고지](THIRD_PARTY_NOTICES.md)

제3자 패키지의 Apache-2.0 고지는 TrustGate 저장소 자체의 라이선스 선언이 아닙니다. 현재 저장소에는 프로젝트 자체의 `LICENSE` 파일이 없으므로 제3자 사용 허가를 프로젝트 전체의 사용 허가로 간주하지 마십시오.
