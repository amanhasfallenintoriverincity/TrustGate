# 제3자 소프트웨어 고지

이 문서는 현재 설치·잠금된 의존성의 사용 내역을 설명합니다. 제3자의 Apache-2.0 허가가 TrustGate 저장소 전체의 라이선스를 결정하지 않습니다. 현재 저장소 루트에는 TrustGate 자체의 `LICENSE` 파일이 없습니다. 재배포자는 자신의 배포물에 포함하는 제3자 구성 요소와 그 고지 의무를 별도로 확인하십시오.

| 구성 요소 | 버전 | 설치 패키지의 라이선스 | 출처 및 용도 |
|---|---|---|---|
| `@alibaba-group/open-code-review` (OpenCodeReview) | 1.12.6 | Apache-2.0 | [alibaba/open-code-review](https://github.com/alibaba/open-code-review) · 변경 파일과 규칙 선택에 사용합니다. |
| `@openai-oauth/core` | 2.0.0 | Apache-2.0 | [EvanZhouDev/openai-oauth](https://github.com/EvanZhouDev/openai-oauth) · 선택적 Codex OAuth 호환 어댑터의 구성 요소입니다. |
| `@openai-oauth/local` | 2.0.0 | Apache-2.0 | [EvanZhouDev/openai-oauth](https://github.com/EvanZhouDev/openai-oauth) · 로컬 인증 연동의 구성 요소입니다. |

버전과 라이선스는 `apps/orchestrator/package.json`, `llm-gateway/package.json` 및 `npm ci` 후 각 설치 패키지의 `package.json`에서 확인했습니다. 세 패키지 모두 설치본의 `LICENSE`가 존재합니다. 두 OAuth 패키지에는 `NOTICE`가 있고, 전체 LICENSE/NOTICE 텍스트는 기존 [게이트웨이 제3자 고지](llm-gateway/THIRD_PARTY_NOTICES.txt)에도 보존되어 있습니다. 검사한 OpenCodeReview 설치본에는 별도의 `NOTICE` 파일이 없었습니다. 배포 시 실제 포함 패키지의 LICENSE 및 존재하는 NOTICE를 확인하여 함께 보존하십시오.

연동 표기는 **OpenAI Codex OAuth 호환 연동(비공식 커뮤니티 어댑터, 로컬 선택 기능)**으로 제한합니다. OpenAI에서 공식적으로 제공하거나 보증하는 OAuth 기능이라는 뜻이 아닙니다. 인증 기능은 fixture 데모의 필수 조건이 아니며, 계정 권한과 서비스 약관을 지켜야 합니다. [게이트웨이 안내](llm-gateway/README.md)를 참고하십시오.

## 웹 대시보드 디자인 참고

상단 바·좌측 탐색·어두운 색상 체계·설치 단계 구성은 사용자가 제공한 `roblox-executor-mcp-main` 대시보드/인스톨러 디자인을 참고했습니다. 해당 소프트웨어의 저작권 및 MIT 허가 고지는 다음과 같습니다. 이 허가는 TrustGate 저장소 전체의 라이선스 선언이 아닙니다.

```text
Copyright 2026 upio

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
