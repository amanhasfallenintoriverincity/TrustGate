# LLM Gateway

AI 보안 분석 계층에서 공급자를 교체할 수 있도록 만든 TypeScript 어댑터입니다.

## 지원 방식

| `kind` | 호출 규격 | 인증 |
|---|---|---|
| `openai-compatible` | `POST {baseUrl}/chat/completions` | 선택한 환경 변수 값을 `Authorization: Bearer`로 전달 |
| `anthropic-compatible` | `POST {baseUrl}/messages` | 선택한 환경 변수 값을 `x-api-key`로 전달 |
| `openai-codex-oauth` | Codex Responses 전송 계층 | `~/.codex/auth.json` 또는 지정한 인증 파일 |

모든 방식은 공통 `LlmClient.generate()` 결과로 정규화합니다. LLM 출력은 후보 분석에만 사용하고, 취약점 확정은 별도의 Docker 실행 검증기가 담당해야 합니다.

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

## Codex OAuth 로그인

`openai-oauth`는 OpenAI 공식 제품이 아닌 커뮤니티 프로젝트입니다. 로컬 개발자가 명시적으로 선택한 경우에만 사용합니다.

```bash
npx openai-oauth@2.0.0 login
```

기본 인증 파일은 `~/.codex/auth.json`입니다. 경로만 확인하려면 다음 명령을 사용합니다. 토큰 값은 출력하지 않습니다.

```bash
python - <<'PY'
from pathlib import Path
p = Path.home() / ".codex" / "auth.json"
print(p, "exists=" + str(p.exists()))
PY
```

## 보안 규칙

- 원격 사용자 지정 엔드포인트는 HTTPS만 허용합니다. HTTP는 loopback 주소만 허용합니다.
- API 키 값은 설정 파일에 넣지 않고 환경 변수 이름만 저장합니다.
- Codex OAuth 토큰은 서비스 DB에 복사하지 않습니다.
- LLM 프로세스와 샌드박스 실행기를 분리합니다. `~/.codex`, API 키, GitHub 쓰기 토큰을 검사 대상 컨테이너에 마운트하거나 주입하지 않습니다.
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
