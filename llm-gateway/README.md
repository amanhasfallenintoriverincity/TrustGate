# LLM Gateway

AI 보안 분석 계층에서 공급자를 교체할 수 있도록 만든 TypeScript 어댑터입니다.

## 지원 방식

| `kind` | 호출 규격 | 인증 |
|---|---|---|
| `openai-compatible` | `POST {baseUrl}/chat/completions` | 선택한 환경 변수 값을 `Authorization` 헤더로 전달합니다. |
| `anthropic-compatible` | `POST {baseUrl}/messages` | 선택한 환경 변수 값을 `x-api-key`로 전달합니다. |
| `openai-codex-oauth` | Codex Responses 전송 계층 | 로컬의 명시적 선택 기능으로만 사용합니다. |

모든 방식은 공통 `LlmClient.generate()` 결과로 정규화합니다. LLM 출력은 후보 분석에만 사용하고, 취약점 확정은 별도의 rootless Podman 격리 실행 결과로 판단합니다. fixture 모드는 LLM과 컨테이너를 호출하지 않고 저장된 보고서를 재생합니다.

## 사용 예시

```ts
import { createLlmClient } from "./src/index.js";

const openaiCompatible = createLlmClient({
  id: "openai-compatible",
  kind: "openai-compatible",
  baseUrl: "https://provider.example/v1",
  model: "model-name",
  apiKeyEnv: "LLM_API_KEY",
});

const anthropicCompatible = createLlmClient({
  id: "anthropic-compatible",
  kind: "anthropic-compatible",
  baseUrl: "https://provider.example/v1",
  model: "model-name",
  apiKeyEnv: "ANTHROPIC_API_KEY",
});

const codexOAuth = createLlmClient({
  id: "codex-oauth",
  kind: "openai-codex-oauth",
  model: "gpt-5.4-mini",
});

const result = await codexOAuth.generate({
  system: "보안 분석 결과를 JSON으로만 반환합니다.",
  messages: [{ role: "user", content: "이 diff를 검토합니다." }],
});
```

## Codex OAuth 연동

OpenAI Codex OAuth 호환 연동(비공식 커뮤니티 어댑터, 로컬 선택 기능)입니다. OpenAI의 공식 기능으로 소개하지 않습니다. 대시보드의 **연결 설정 → 제공자 종류**에서 **Codex OAuth (로컬·비공식)**를 선택할 수 있습니다. **Codex OAuth 인증**을 누르면 화면에 승인 링크가 나타납니다. 링크를 열어 브라우저에서 승인을 마치면 로컬 서버가 콜백을 수신하고 인증 상태를 표시합니다. 이미 인증 파일이 있으면 화면에서 덮어쓰지 않습니다. 이때 API URL·키 환경 변수는 사용하지 않고 서버에서 실행되는 어댑터의 로컬 인증 정보를 사용합니다. 모델과 샌드박스 이미지를 지정해 저장한 다음 **연결 테스트**를 눌러 실제 사용 가능 여부를 확인합니다. 연결 테스트에는 모델 요청이 발생할 수 있습니다. fixture 데모에는 로그인이나 유료 키가 필요하지 않습니다. 로컬에서 명시적으로 선택한 경우에만 계정 권한과 서비스 약관을 확인하고 사용하십시오. 인증 파일 경로나 토큰 값을 로그·화면·샌드박스에 전달하지 마십시오.

## 보안 규칙

- 원격 사용자 지정 엔드포인트는 HTTPS만 허용합니다. HTTP는 loopback 주소만 허용합니다.
- API 키 값은 설정 파일에 넣지 않고 환경 변수 이름만 저장합니다.
- Codex OAuth 토큰은 서비스 DB에 복사하지 않습니다.
- LLM 프로세스와 샌드박스 실행기를 분리합니다. OAuth 인증 데이터, API 키, GitHub 쓰기 토큰을 검사 대상 컨테이너에 마운트하거나 주입하지 않습니다.
- 오류 본문은 길이를 제한하며 자격 증명을 로그에 남기지 않습니다.
- OpenAI OAuth는 계정별 사용 권한과 약관을 따르며, 공용·공유 계정 또는 토큰 풀링에 사용하지 않습니다.

## 검증

```bash
npm test
npm run typecheck
npm run build
```

테스트는 실제 유료 API를 호출하지 않고 가짜 전송 계층으로 요청 형식, 인증 헤더, 오류 처리, OAuth 토큰 비노출을 확인합니다.

## 제3자 고지

- `@openai-oauth/core` 2.0.0, Apache-2.0
- `@openai-oauth/local` 2.0.0, Apache-2.0
- 원본 프로젝트: <https://github.com/EvanZhouDev/openai-oauth>

배포물에는 각 패키지의 `LICENSE`와 `NOTICE`를 함께 보존해야 합니다.
