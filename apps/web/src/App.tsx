import { useState } from "react";
import type { JSX } from "react";

type Tone = "done" | "wait" | "danger";

type Stage = {
  readonly id: string;
  readonly title: string;
  readonly tone: Tone;
  readonly statusLabel: string;
  readonly detail: string;
  readonly meta: string;
};

type Metric = {
  readonly label: string;
  readonly value: string;
  readonly meta: string;
};

type EvidenceCard = {
  readonly title: string;
  readonly tone: Tone;
  readonly statusLabel: string;
  readonly body: string;
  readonly caption: string;
};

const TONE_ICON: Record<Tone, string> = {
  done: "✓",
  wait: "◌",
  danger: "!",
};

/** 카드 한 장에 색, 아이콘, 문구를 함께 붙이기 위한 공통 클래스입니다. */
const statusClass = (tone: Tone): string => `status status-${tone}`;

const SAMPLE_NOTICE =
  "정적 샘플 화면입니다. 실행 API를 연결하기 전이라 실제 분석은 시작되지 않습니다.";

const METRICS: readonly Metric[] = [
  { label: "검토 파일", value: "2", meta: "OCR 수집" },
  { label: "도출 가설", value: "2", meta: "LLM 후보" },
  { label: "재현 확정", value: "3", meta: "수정 전 버전" },
  { label: "회귀 통과", value: "3", meta: "수정 후 버전" },
];

const STAGES: readonly Stage[] = [
  {
    id: "files",
    title: "변경 파일",
    tone: "done",
    statusLabel: "수집 완료",
    detail: "OCR이 diff에서 검토할 파일과 규칙 후보를 고릅니다.",
    meta: "server.ts, store.ts",
  },
  {
    id: "hypotheses",
    title: "취약점 가설",
    tone: "done",
    statusLabel: "후보 2건",
    detail: "LLM은 가설과 검증 시나리오만 만들고 판정하지 않습니다.",
    meta: "가격 조작, 소유권 우회",
  },
  {
    id: "reproduce",
    title: "격리 재현",
    tone: "done",
    statusLabel: "재현 3건",
    detail: "네트워크와 자격 증명을 뺀 컨테이너가 수정 전 버전에 같은 요청을 보냅니다.",
    meta: "수정 전 버전 기준",
  },
  {
    id: "regression",
    title: "패치 회귀 검증",
    tone: "done",
    statusLabel: "차단 3건",
    detail: "같은 요청을 패치 버전에 보내 차단 여부와 상태 변화를 비교합니다.",
    meta: "수정 후 버전 기준",
  },
];

const EVIDENCE: readonly EvidenceCard[] = [
  {
    title: "요청",
    tone: "wait",
    statusLabel: "재현 시나리오",
    body: `POST /api/purchase\n{ "itemId": "sword", "price": -100 }`,
    caption: "가설 price-authority의 테스트 negative-price",
  },
  {
    title: "수정 전 응답",
    tone: "danger",
    statusLabel: "취약 재현됨",
    body: `HTTP 200\n{ "balance": 100 }`,
    caption: "기대 400, 실제 200",
  },
  {
    title: "수정 후 응답",
    tone: "done",
    statusLabel: "차단 확인",
    body: `HTTP 400\n{ "balance": 0 }`,
    caption: "기대 400, 실제 400",
  },
  {
    title: "판정",
    tone: "done",
    statusLabel: "회귀 통과",
    body: `수정 전: 재현 확인\n수정 후: 차단 확인\n회귀 판정: 통과`,
    caption: "두 컨테이너의 실행 결과 비교",
  },
];

const MAINTENANCE_NOTES: readonly string[] = [
  "이 화면은 결과를 읽기만 합니다. 분석은 오케스트레이터가 맡고 브라우저는 증거를 보여줍니다.",
  "팝업과 대화상자를 쓰지 않습니다. 진행 상태와 오류는 페이지 안 문장으로 표시합니다.",
  "360px 폭까지 가로 스크롤 없이 읽히도록 맞췄습니다.",
  "LLM은 가설만 만들고, 판정은 격리 컨테이너의 실행 결과가 정합니다.",
];

const THIRD_PARTY_NOTICES: readonly string[] = [
  "OpenCodeReview 1.12.6, Apache-2.0",
  "@openai-oauth/core 2.0.0, Apache-2.0",
  "@openai-oauth/local 2.0.0, Apache-2.0",
  "원본 프로젝트: github.com/EvanZhouDev/openai-oauth",
];

const OAUTH_NOTICE =
  "배포물에는 각 패키지의 LICENSE와 NOTICE를 함께 보존합니다. Codex OAuth 연동은 OpenAI의 공식 제품이 아니라 비공식 커뮤니티 어댑터이고, 로컬에서 직접 켠 사람만 씁니다. 이 화면은 토큰 값과 인증 파일 경로를 표시하지 않습니다.";

export default function App(): JSX.Element {
  const [notice, setNotice] = useState<string | null>(null);

  const handleSampleRun = (): void => {
    setNotice(SAMPLE_NOTICE);
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <p className="brand">TrustGate</p>
        <h1 className="headline">신뢰 경계와 비즈니스 로직 취약점을 실행 증거로 확인합니다</h1>
        <p className="lede">
          변경 파일에서 가설을 세우고, 격리 컨테이너에서 재현한 뒤, 패치 버전의 회귀까지 한 페이지에서
          확인합니다. 진행 상태와 판정 근거는 팝업 없이 이 화면에 바로 쌓입니다.
        </p>
        <div className="header-actions">
          <button type="button" className="action" onClick={handleSampleRun}>
            샘플 분석 실행
          </button>
          <span className="action-meta">fixture 모드 · 유료 API 호출 없음</span>
        </div>
        {/* 노드가 클릭 시점에 삽입되면 보조기술이 낭독을 놓치므로 리전을 항상 렌더하고
            자식만 조건부로 채웁니다. 비어 있을 때는 CSS :empty가 1px 시각적 숨김으로
            화면에서만 지우고, 접근성 트리에는 role=status로 남깁니다(display: none 금지). */}
        <p className="action-notice" role="status" aria-live="polite">
          {notice === null ? null : (
            <>
              <span aria-hidden="true">{TONE_ICON.wait}</span>
              {notice}
            </>
          )}
        </p>
      </header>

      <section aria-label="요약 지표" className="surface">
        <div className="section-head">
          <h2>요약 지표</h2>
          <span className={statusClass("wait")}>
            <span aria-hidden="true">{TONE_ICON.wait}</span>
            샘플 값
          </span>
        </div>
        <ul className="metric-grid">
          {METRICS.map((metric) => (
            <li key={metric.label} className="metric">
              <span className="metric-value">{metric.value}</span>
              <span className="metric-label">{metric.label}</span>
              <span className="metric-meta">{metric.meta}</span>
            </li>
          ))}
        </ul>
        <p className="section-foot">
          숫자는 fixture-plan.json 기준 예시입니다. 실행 API를 연결하면 실제 결과로 바뀝니다.
        </p>
      </section>

      <section aria-label="분석 흐름" className="surface flow">
        <div className="section-head">
          <h2>분석 흐름</h2>
          <p className="section-note">네 단계가 끝나면 단계마다 판정 근거가 남습니다.</p>
        </div>
        {STAGES.map((stage) => (
          <article key={stage.id} className="card">
            <h3 className="card-title">{stage.title}</h3>
            <p className={statusClass(stage.tone)}>
              <span aria-hidden="true">{TONE_ICON[stage.tone]}</span>
              {stage.statusLabel}
            </p>
            <p className="card-body">{stage.detail}</p>
            <p className="card-meta">{stage.meta}</p>
          </article>
        ))}
      </section>

      <section aria-label="실행 증거" className="surface evidence">
        <div className="section-head">
          <h2>실행 증거</h2>
          <p className="section-note">요청, 수정 전 응답, 수정 후 응답, 판정을 같은 화면에서 비교합니다.</p>
        </div>
        {EVIDENCE.map((item) => (
          <article key={item.title} className="card">
            <h3 className="card-title">{item.title}</h3>
            <p className={statusClass(item.tone)}>
              <span aria-hidden="true">{TONE_ICON[item.tone]}</span>
              {item.statusLabel}
            </p>
            <pre className="evidence-body">
              <code>{item.body}</code>
            </pre>
            <p className="card-meta">{item.caption}</p>
          </article>
        ))}
      </section>

      <footer className="app-footer">
        <section aria-label="관리 범위" className="footer-block">
          <h2>관리 범위</h2>
          <ul className="footer-list">
            {MAINTENANCE_NOTES.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
        <section aria-label="라이선스와 제3자 고지" className="footer-block">
          <h2>라이선스와 제3자 고지</h2>
          <ul className="footer-list">
            {THIRD_PARTY_NOTICES.map((noticeLine) => (
              <li key={noticeLine}>{noticeLine}</li>
            ))}
          </ul>
          <p className="footer-notice">{OAUTH_NOTICE}</p>
        </section>
      </footer>
    </main>
  );
}
