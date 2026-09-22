import { useRef, useState } from "react";
import type { JSX } from "react";

import {
  startFixtureRun,
  type ExecutionResult,
  type ExecutionVerdict,
  type JsonValue,
  type RegressionVerdict,
  type RunHypothesis,
  type RunResponse,
  type RunTest,
} from "./lib/api";

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

/**
 * 실행 상태는 네 단계뿐입니다. polling·WebSocket은 쓰지 않습니다(YAGNI): 오케스트레이터가
 * fixture 실행을 한 번에 끝내고 201로 최종 보고서를 돌려주므로, 브라우저는 요청 하나를
 * 기다렸다가 결과를 그립니다.
 */
type RunState =
  | { readonly phase: "idle" }
  | { readonly phase: "running" }
  | { readonly phase: "success"; readonly report: RunResponse }
  | { readonly phase: "error"; readonly message: string };

const TONE_ICON: Record<Tone, string> = {
  done: "✓",
  wait: "◌",
  danger: "!",
};

/** 카드 한 장에 색, 아이콘, 문구를 함께 붙이기 위한 공통 클래스입니다. */
const statusClass = (tone: Tone): string => `status status-${tone}`;

/** 실행 판정 문구. `contracts`의 executionResultSchema verdict enum과 1:1입니다. */
const EXECUTION_LABELS: Record<ExecutionVerdict, string> = {
  CONFIRMED: "취약 재현됨",
  BLOCKED: "차단 확인",
  UNVERIFIED: "판정 보류",
  ERROR: "실행 오류",
};

const EXECUTION_TONES: Record<ExecutionVerdict, Tone> = {
  CONFIRMED: "danger",
  BLOCKED: "done",
  UNVERIFIED: "wait",
  ERROR: "danger",
};

/** 패치 회귀 판정 문구. `verdict.ts`의 RegressionVerdict와 1:1입니다. */
const REGRESSION_LABELS: Record<RegressionVerdict, string> = {
  FIXED: "회귀 통과",
  STILL_VULNERABLE: "여전히 취약",
  NOT_REPRODUCED: "재현 안 됨",
  UNVERIFIED: "판정 불가",
};

const REGRESSION_TONES: Record<RegressionVerdict, Tone> = {
  FIXED: "done",
  STILL_VULNERABLE: "danger",
  NOT_REPRODUCED: "wait",
  UNVERIFIED: "wait",
};

const SAMPLE_BADGE = "샘플 값";
const RESULT_BADGE = "실제 실행 결과";

const SAMPLE_METRIC_FOOT =
  "아직 실행하지 않아 fixture-plan.json 기준 예시 값을 보여줍니다. 위 버튼을 누르면 실제 실행 결과로 바뀝니다.";

const RESULT_METRIC_FOOT =
  "숫자는 fixture-plan.json을 실행한 결과에서 계산했습니다. 판정은 격리 실행 결과가 정합니다.";

const SAMPLE_METRICS: readonly Metric[] = [
  { label: "검토 파일", value: "2", meta: "OCR 수집" },
  { label: "도출 가설", value: "2", meta: "LLM 후보" },
  { label: "재현 확정", value: "3", meta: "수정 전 버전" },
  { label: "회귀 차단", value: "3", meta: "수정 후 버전" },
];

const STAGE_DETAILS = {
  files: "OCR이 diff에서 검토할 파일과 규칙 후보를 고릅니다.",
  hypotheses: "LLM은 가설과 검증 시나리오만 만들고 판정하지 않습니다.",
  reproduce: "네트워크와 자격 증명을 뺀 컨테이너가 수정 전 버전에 같은 요청을 보냅니다.",
  regression: "같은 요청을 패치 버전에 보내 차단 여부와 상태 변화를 비교합니다.",
} as const;

const SAMPLE_STAGES: readonly Stage[] = [
  {
    id: "files",
    title: "변경 파일",
    tone: "done",
    statusLabel: "수집 완료",
    detail: STAGE_DETAILS.files,
    meta: "server.ts, store.ts",
  },
  {
    id: "hypotheses",
    title: "취약점 가설",
    tone: "done",
    statusLabel: "후보 2건",
    detail: STAGE_DETAILS.hypotheses,
    meta: "가격 조작, 소유권 우회",
  },
  {
    id: "reproduce",
    title: "격리 재현",
    tone: "done",
    statusLabel: "재현 3건",
    detail: STAGE_DETAILS.reproduce,
    meta: "수정 전 버전 기준",
  },
  {
    id: "regression",
    title: "패치 회귀 검증",
    tone: "done",
    statusLabel: "차단 3건",
    detail: STAGE_DETAILS.regression,
    meta: "수정 후 버전 기준",
  },
];

const SAMPLE_EVIDENCE: readonly EvidenceCard[] = [
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

/** 가설을 가로질러 테스트를 등장 순서대로 펼칩니다. 첫 테스트가 화면의 대표 증거입니다. */
const flattenTests = (
  report: RunResponse,
): readonly { readonly hypothesis: RunHypothesis; readonly test: RunTest }[] =>
  report.hypotheses.flatMap((hypothesis) =>
    hypothesis.tests.map((test) => ({ hypothesis, test })),
  );

const countVerdicts = (
  tests: readonly RunTest[],
  pick: (test: RunTest) => ExecutionVerdict,
  expected: ExecutionVerdict,
): number => tests.filter((test) => pick(test) === expected).length;

const reportMetrics = (report: RunResponse): readonly Metric[] => {
  const tests = flattenTests(report).map(({ test }) => test);
  return [
    {
      label: "검토 파일",
      value: String(report.reviewedFiles.length),
      meta: "fixture 실행 대상",
    },
    { label: "도출 가설", value: String(report.hypotheses.length), meta: "LLM 후보" },
    {
      label: "재현 확정",
      value: String(
        countVerdicts(tests, ({ vulnerableResult }) => vulnerableResult.verdict, "CONFIRMED"),
      ),
      meta: "수정 전 버전",
    },
    {
      label: "회귀 차단",
      value: String(
        countVerdicts(tests, ({ patchedResult }) => patchedResult.verdict, "BLOCKED"),
      ),
      meta: "수정 후 버전",
    },
  ];
};

const reportStages = (report: RunResponse): readonly Stage[] => {
  const tests = flattenTests(report).map(({ test }) => test);
  const confirmed = countVerdicts(
    tests,
    ({ vulnerableResult }) => vulnerableResult.verdict,
    "CONFIRMED",
  );
  const blocked = countVerdicts(tests, ({ patchedResult }) => patchedResult.verdict, "BLOCKED");
  return [
    {
      id: "files",
      title: "변경 파일",
      tone: "done",
      statusLabel: `파일 ${report.reviewedFiles.length}건`,
      detail: STAGE_DETAILS.files,
      meta: report.reviewedFiles.length === 0 ? "검토 파일 없음" : report.reviewedFiles.join(", "),
    },
    {
      id: "hypotheses",
      title: "취약점 가설",
      tone: "done",
      statusLabel: `가설 ${report.hypotheses.length}건`,
      detail: STAGE_DETAILS.hypotheses,
      meta:
        report.hypotheses.length === 0
          ? "가설 없음"
          : report.hypotheses.map(({ title }) => title).join(" · "),
    },
    {
      id: "reproduce",
      title: "격리 재현",
      tone: confirmed > 0 ? "danger" : "wait",
      statusLabel: `재현 확정 ${confirmed}건`,
      detail: STAGE_DETAILS.reproduce,
      meta: `수정 전 버전 기준 · 총 ${report.durations.totalMs}ms`,
    },
    {
      id: "regression",
      title: "패치 회귀 검증",
      tone: REGRESSION_TONES[report.regressionVerdict],
      statusLabel: `${REGRESSION_LABELS[report.regressionVerdict]} · 차단 ${blocked}건`,
      detail: STAGE_DETAILS.regression,
      meta: `수정 후 버전 기준 · ${report.provider} / ${report.model}`,
    },
  ];
};

const formatJson = (value: JsonValue): string => JSON.stringify(value) ?? "null";

/** 실행 결과 한 건을 카드 본문 줄로 폅니다. 색만으로 판정을 전달하지 않습니다. */
const executionLines = (result: ExecutionResult): readonly string[] => [
  `판정 ${result.verdict}`,
  `실행 ${result.executed ? "완료" : "미실행"}`,
  ...result.evidence.map(
    (item) => `${item.kind}: 기대 ${formatJson(item.expected)}, 실제 ${formatJson(item.actual)}`,
  ),
];

const requestBody = (test: RunTest): string =>
  test.request.body === undefined
    ? `${test.request.method} ${test.request.path}`
    : `${test.request.method} ${test.request.path}\n${JSON.stringify(test.request.body, null, 2)}`;

/**
 * 실행 증거는 report의 첫 테스트에서 요청·수정 전·수정 후·판정 네 장으로 재구성합니다.
 * 테스트가 없으면 아무 카드도 그리지 않습니다(빈 배열).
 */
const reportEvidence = (report: RunResponse): readonly EvidenceCard[] => {
  const pairs = flattenTests(report);
  const first = pairs[0];
  if (first === undefined) return [];
  const { hypothesis, test } = first;
  const vulnerable = executionLines(test.vulnerableResult);
  const patched = executionLines(test.patchedResult);
  return [
    {
      title: "요청",
      tone: "wait",
      statusLabel: `재현 시나리오 · ${test.id}`,
      body: requestBody(test),
      caption: `가설 ${hypothesis.id}의 테스트 ${test.id}`,
    },
    {
      title: "수정 전 응답",
      tone: EXECUTION_TONES[test.vulnerableResult.verdict],
      statusLabel: EXECUTION_LABELS[test.vulnerableResult.verdict],
      body: vulnerable.join("\n"),
      caption: `수정 전 실행 결과 (${hypothesis.id}/${test.id})`,
    },
    {
      title: "수정 후 응답",
      tone: EXECUTION_TONES[test.patchedResult.verdict],
      statusLabel: EXECUTION_LABELS[test.patchedResult.verdict],
      body: patched.join("\n"),
      caption: `수정 후 실행 결과 (${hypothesis.id}/${test.id})`,
    },
    {
      title: "판정",
      tone: REGRESSION_TONES[test.regressionVerdict],
      statusLabel: REGRESSION_LABELS[test.regressionVerdict],
      body: [
        `수정 전: ${test.vulnerableResult.verdict}`,
        `수정 후: ${test.patchedResult.verdict}`,
        `회귀 판정: ${REGRESSION_LABELS[test.regressionVerdict]} (${test.regressionVerdict})`,
      ].join("\n"),
      caption: `전체 판정: ${REGRESSION_LABELS[report.regressionVerdict]} (${report.regressionVerdict}) — 테스트 ${pairs.length}건 중 첫 건`,
    },
  ];
};

const statusNotice = (
  run: RunState,
): { readonly tone: Tone; readonly text: string } | null => {
  if (run.phase === "running") return { tone: "wait", text: "fixture 분석을 실행하는 중입니다…" };
  if (run.phase === "success") {
    return { tone: "done", text: `분석 완료 — 실행 ${run.report.runId}` };
  }
  if (run.phase === "error") return { tone: "danger", text: run.message };
  return null;
};

const FAILURE_MESSAGE = "분석 실행이 실패했습니다";

export default function App(): JSX.Element {
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  /**
   * 재진입 가드입니다. `disabled`는 다음 렌더 뒤에야 붙으므로, 같은 태스크에서 두 번
   * 눌리면 POST가 두 번 나가고 나중에 끝난 응답이 화면을 덮어씁니다. 상태 대신 ref로
   * 임계 구역을 잠그고 `finally`에서 풀어, 실행이 어떤 식으로 끝나도 다시 실행할 수 있습니다.
   */
  const isRunningRef = useRef(false);

  const handleRun = (): void => {
    if (isRunningRef.current) return; // 임계 구역 밖: 중복 요청은 여기서 끝냅니다.
    isRunningRef.current = true;
    setRun({ phase: "running" });
    void startFixtureRun()
      .then(
        (report) => {
          setRun({ phase: "success", report });
        },
        (error: unknown) => {
          setRun({
            phase: "error",
            message: error instanceof Error ? error.message : FAILURE_MESSAGE,
          });
        },
      )
      .finally(() => {
        isRunningRef.current = false;
      });
  };

  const isSuccess = run.phase === "success";
  const metrics = isSuccess ? reportMetrics(run.report) : SAMPLE_METRICS;
  const stages = isSuccess ? reportStages(run.report) : SAMPLE_STAGES;
  const evidence = isSuccess ? reportEvidence(run.report) : SAMPLE_EVIDENCE;
  const notice = statusNotice(run);
  const badgeTone: Tone = isSuccess ? "done" : "wait";

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
          <button
            type="button"
            className="action"
            onClick={handleRun}
            disabled={run.phase === "running"}
          >
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
              <span aria-hidden="true">{TONE_ICON[notice.tone]}</span>
              {notice.text}
            </>
          )}
        </p>
      </header>

      <section aria-label="요약 지표" className="surface">
        <div className="section-head">
          <h2>요약 지표</h2>
          <span className={statusClass(badgeTone)}>
            <span aria-hidden="true">{TONE_ICON[badgeTone]}</span>
            {isSuccess ? RESULT_BADGE : SAMPLE_BADGE}
          </span>
        </div>
        <ul className="metric-grid">
          {metrics.map((metric) => (
            <li key={metric.label} className="metric">
              <span className="metric-value">{metric.value}</span>
              <span className="metric-label">{metric.label}</span>
              <span className="metric-meta">{metric.meta}</span>
            </li>
          ))}
        </ul>
        <p className="section-foot">{isSuccess ? RESULT_METRIC_FOOT : SAMPLE_METRIC_FOOT}</p>
      </section>

      <section aria-label="분석 흐름" className="surface flow">
        <div className="section-head">
          <h2>분석 흐름</h2>
          <p className="section-note">
            {isSuccess
              ? "방금 실행한 fixture 분석의 단계별 결과입니다."
              : "네 단계가 끝나면 단계마다 판정 근거가 남습니다."}
          </p>
        </div>
        {stages.map((stage) => (
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
          <p className="section-note">
            {isSuccess
              ? "첫 테스트의 요청과 두 컨테이너 실행 결과, 그리고 판정입니다."
              : "요청, 수정 전 응답, 수정 후 응답, 판정을 같은 화면에서 비교합니다."}
          </p>
        </div>
        {evidence.map((item) => (
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
