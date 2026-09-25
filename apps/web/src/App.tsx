import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  type ExecutionResult,
  type ExecutionVerdict,
  type JsonValue,
  type RegressionVerdict,
  type RunHypothesis,
  type RunResponse,
  type RunTest,
} from "./lib/api";
import Setup from "./Setup";
import { startWorkspaceRun, type SetupStatus } from "./lib/setup";
import { installSkill, type SkillAgent } from "./lib/skills";

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
 * workspace 실행을 한 번에 끝내고 201로 최종 보고서를 돌려주므로, 브라우저는 요청 하나를
 * 기다렸다가 결과를 그립니다.
 */
type RunState =
  | { readonly phase: "idle" }
  | { readonly phase: "running"; readonly source: "workspace" }
  | { readonly phase: "success"; readonly report: RunResponse }
  | { readonly phase: "error"; readonly source: "workspace"; readonly message: string };

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

const RESULT_BADGE = "실제 실행 결과";

const RESULT_METRIC_FOOT =
  "숫자는 이번 workspace 실행 보고서에서 계산했습니다. 외부 대상의 취약점 확정이나 회귀 통과를 보증하지 않습니다.";

const EMPTY_METRICS: readonly Metric[] = [
  { label: "검토 파일", value: "—", meta: "분석 결과 없음" },
  { label: "도출 가설", value: "—", meta: "분석 결과 없음" },
  { label: "재현 확정", value: "—", meta: "분석 결과 없음" },
  { label: "회귀 차단", value: "—", meta: "분석 결과 없음" },
];
const EMPTY_STAGES: readonly Stage[] = [];
const EMPTY_EVIDENCE: readonly EvidenceCard[] = [];

const STAGE_DETAILS = {
  files: "OCR이 diff에서 검토할 파일과 규칙 후보를 고릅니다.",
  hypotheses: "LLM은 가설과 검증 시나리오만 만들고 판정하지 않습니다.",
  reproduce: "격리 컨테이너에서 수정 전 상태를 실행해 가설을 검증합니다.",
  regression: "수정 전·후 상태를 비교해 재현과 회귀 판정을 함께 남깁니다.",
} as const;

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
      meta: report.source === "workspace" ? "프로젝트 실행 대상" : "fixture 실행 대상",
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

/** 깊은 값을 pretty-print하지 못했을 때 값 대신 남기는 고정 문구입니다(엔진 원문 비노출). */
const UNSHOWABLE_VALUE = "표시할 수 없는 값입니다";

/**
 * 실행 결과에서 온 값은 신뢰 경계 밖 데이터라 깊이를 믿을 수 없습니다. pretty-print는 값의
 * 깊이만큼 재귀해서 깊게 중첩된 값(엔진 실측: 10k 이상)에서 `RangeError: Maximum call stack
 * size exceeded`를 던지고, 에러 바운더리가 없어 화면 전체가 지워집니다. 그래서 pretty-print는
 * 이 한 곳에서만 하고, 실패하면 값이나 엔진 문구 대신 고정 문구로 낮춥니다(얕은 값은 그대로).
 * 한 줄짜리 `formatJson`(compact)은 같은 깊이에서도 스택을 쓰지 않아 이 위험이 없습니다.
 */
const prettyJson = (value: JsonValue): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return UNSHOWABLE_VALUE;
  }
};

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
    : `${test.request.method} ${test.request.path}\n${prettyJson(test.request.body)}`;

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
  if (run.phase === "running") return { tone: "wait", text: "프로젝트 분석을 실행하는 중입니다…" };
  if (run.phase === "success") return { tone: "done", text: `프로젝트 분석 완료 — 실행 ${run.report.runId}` };
  if (run.phase === "error") return { tone: "danger", text: run.message };
  return null;
};

const AGENTS: readonly { readonly id: SkillAgent; readonly label: string; readonly detail: string }[] = [
  { id: "codex", label: "Codex", detail: "프로젝트 스킬" },
  { id: "claude", label: "Claude", detail: "프로젝트 스킬" },
  { id: "cursor", label: "Cursor", detail: "프로젝트 스킬" },
  { id: "hermes", label: "Hermes", detail: "설치 후 사용자가 직접 신뢰 확인" },
];

type WorkflowStep = "dashboard" | "setup" | "project" | "skills" | "results";
const WORKFLOW_STEPS: readonly { readonly id: WorkflowStep; readonly label: string }[] = [
  { id: "dashboard", label: "대시보드" },
  { id: "setup", label: "연결 설정" },
  { id: "project", label: "프로젝트 선택/분석" },
  { id: "skills", label: "에이전트 스킬" },
  { id: "results", label: "결과 확인" },
];
const stepFromLocation = (): WorkflowStep => {
  const step = window.location.hash.slice(2);
  return WORKFLOW_STEPS.find(({ id }) => id === step)?.id ?? "dashboard";
};
type SkillState = "idle" | "pending" | "installed" | "exists" | "error";

export default function App(): JSX.Element {
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [setupOpenSignal, setSetupOpenSignal] = useState(0);
  const [repoPath, setRepoPath] = useState("");
  const [activeStep, setActiveStep] = useState<WorkflowStep>(stepFromLocation);
  const [skills, setSkills] = useState<Partial<Record<SkillAgent, SkillState>>>({});
  const installing = useRef<Set<SkillAgent>>(new Set());
  const workspaceMode = setupStatus?.mode === "workspace";

  useEffect(() => {
    const syncLocation = (): void => setActiveStep(stepFromLocation());
    window.addEventListener("popstate", syncLocation);
    window.addEventListener("hashchange", syncLocation);
    return () => {
      window.removeEventListener("popstate", syncLocation);
      window.removeEventListener("hashchange", syncLocation);
    };
  }, []);

  const navigate = (step: WorkflowStep): void => {
    if (window.location.hash !== `#/${step}`) window.history.pushState(null, "", `#/${step}`);
    setActiveStep(step);
    if (step === "setup") setSetupOpenSignal((current) => current + 1);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };

  const handleInstall = (agent: SkillAgent): void => {
    if (!workspaceMode || installing.current.has(agent)) return;
    installing.current.add(agent);
    setSkills((current) => ({ ...current, [agent]: "pending" }));
    void installSkill(agent).then((result) => {
      setSkills((current) => ({ ...current, [agent]: result }));
    }, () => {
      setSkills((current) => ({ ...current, [agent]: "error" }));
    }).finally(() => {
      installing.current.delete(agent);
    });
  };
  /**
   * 재진입 가드입니다. `disabled`는 다음 렌더 뒤에야 붙으므로, 같은 태스크에서 두 번
   * 눌리면 POST가 두 번 나가고 나중에 끝난 응답이 화면을 덮어씁니다. 상태 대신 ref로
   * 임계 구역을 잠그고 `finally`에서 풀어, 실행이 어떤 식으로 끝나도 다시 실행할 수 있습니다.
   */
  const isRunningRef = useRef(false);

  const handleRun = (): void => {
    if (isRunningRef.current || !workspaceMode || !setupStatus?.configured) return;
    // 임계 구역 밖: 중복 요청과 서버 모드에 맞지 않는 요청은 여기서 끝냅니다.
    isRunningRef.current = true;
    setRun({ phase: "running", source: "workspace" });
    navigate("results");
    void startWorkspaceRun(repoPath)
      .then(
        (report) => {
          setRun({ phase: "success", report });
        },
        () => {
          setRun({
            phase: "error",
            source: "workspace",
            message: "프로젝트 분석에 실패했습니다. 서버 설정과 저장소 경로를 확인해 주세요.",
          });
        },
      )
      .finally(() => {
        isRunningRef.current = false;
      });
  };

  const isSuccess = run.phase === "success";
  const hasAttempt = run.phase !== "idle";
  const metrics: readonly Metric[] = isSuccess
    ? reportMetrics(run.report)
    : EMPTY_METRICS;
  const stages = isSuccess ? reportStages(run.report) : EMPTY_STAGES;
  const evidence = isSuccess ? reportEvidence(run.report) : EMPTY_EVIDENCE;
  const notice = statusNotice(run);
  const badgeTone: Tone = isSuccess ? "done" : "wait";

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="topbar-brand"><span className="brand-mark" aria-hidden="true">T</span><span className="brand">TrustGate</span></div>
        <span className="topbar-location">분석 워크스페이스 <span aria-hidden="true">/</span> {WORKFLOW_STEPS.find(({ id }) => id === activeStep)?.label}</span>
        <span className="topbar-mode">{setupStatus === null ? "모드 확인 중" : workspaceMode ? "WORKSPACE · 서버 고정" : "FIXTURE · 저장된 재생"}</span>
      </div>
      <aside className="sidebar">
        <p className="sidebar-label">WORKFLOW</p>
        <nav aria-label="주 메뉴" className="sidebar-nav">
          {WORKFLOW_STEPS.map(({ id, label }, index) => (
            <Button key={id} type="button" variant="ghost" className={cn("sidebar-link", activeStep === id && "is-active")}
              onClick={() => navigate(id)} aria-current={activeStep === id ? "page" : undefined}>
              <span className="sidebar-index" aria-hidden="true">0{index + 1}</span>{label}
            </Button>
          ))}
        </nav>
        <div className="sidebar-bottom"><span>LOCAL / TRUSTGATE</span><span>브라우저에서는 루트 변경 불가</span></div>
      </aside>
      <main className="page-content">
        <header className="run-controls">
          <h1 className="sr-only">TrustGate 분석 워크스페이스</h1>
          {/* 항상 존재하는 라이브 리전: CSS :empty는 시각적으로만 숨깁니다. */}
          <p className="action-notice" role="status" aria-live="polite">
            {notice === null ? null : <><span aria-hidden="true">{TONE_ICON[notice.tone]}</span>{notice.text}</>}
          </p>
        </header>

        {/* Keep the setup draft mounted across pages without exposing inactive content. */}
        <div hidden={activeStep !== "setup"}>
          <Setup onStatusChange={setSetupStatus} openSignal={setupOpenSignal} />
        </div>

        {activeStep === "dashboard" && <div className="dashboard-home">
          <div className="dashboard-heading">
            <div><span className="eyebrow">TRUSTGATE / OVERVIEW</span><h1>보안 분석 대시보드</h1><p className="section-note">AI가 취약점 가설을 세우고 격리 환경에서 검증한 결과를 확인합니다.</p></div>
            <Button type="button" disabled={run.phase === "running" || !workspaceMode || !setupStatus?.configured} onClick={handleRun}>{run.phase === "running" ? "분석 중…" : "프로젝트 분석 시작"}</Button>
          </div>
          <div className="dashboard-metrics" aria-label="분석 요약">
            {metrics.map((metric) => <Card className="dashboard-metric" key={metric.label}><span className="metric-label">{metric.label}</span><strong className="metric-value">{metric.value}</strong><span className="metric-meta">{metric.meta}</span></Card>)}
          </div>
          <div className="dashboard-panels">
            <Card as="section" className="surface" aria-label="분석 대상">
              <CardHeader className="section-head"><h2>분석 대상</h2><span className="status status-wait">{workspaceMode ? "WORKSPACE" : "설정 필요"}</span></CardHeader>
              <CardContent className="workspace-fields">
                <Field className="workspace-path"><FieldLabel htmlFor="dashboard-repo-path">저장소 상대 경로</FieldLabel><Input id="dashboard-repo-path" value={repoPath} maxLength={512} spellCheck={false} autoComplete="off" placeholder="비워두면 서버의 기본 저장소 루트" onChange={(event) => setRepoPath(event.target.value)} /></Field>
                <p className="section-note">서버가 허용한 루트 안에서만 분석합니다. 경로를 비우면 기본 루트를 사용합니다.</p>
                {(!workspaceMode || !setupStatus?.configured) && <p className="section-note">분석을 시작하려면 운영자가 서버를 workspace 모드로 실행하고 연결 설정을 저장해야 합니다.</p>}
              </CardContent>
            </Card>
            <Card as="section" className="surface" aria-label="최근 분석 상태">
              <CardHeader className="section-head"><h2>최근 분석 상태</h2><span className={statusClass(run.phase === "error" ? "danger" : run.phase === "success" ? "done" : "wait")}>{run.phase === "running" ? "진행 중" : run.phase === "success" ? "완료" : run.phase === "error" ? "실패" : "실행 기록 없음"}</span></CardHeader>
              <p className="section-note">{notice?.text ?? "분석을 실행하면 이 세션의 결과가 표시됩니다. 이전 실행 기록은 불러오지 않습니다."}</p>
              {run.phase === "success" && <Button type="button" variant="outline" onClick={() => navigate("results")}>검증 근거 보기</Button>}
              {run.phase === "error" && <p className="section-note">설정과 허용된 프로젝트 경로를 확인한 뒤 다시 실행하세요.</p>}
            </Card>
          </div>
          <div className="dashboard-shortcuts"><Button type="button" variant="outline" onClick={() => navigate("setup")}>연결 설정</Button><Button type="button" variant="outline" onClick={() => navigate("results")}>결과 확인</Button><Button type="button" variant="outline" onClick={() => navigate("skills")}>에이전트 스킬</Button></div>
        </div>}

        {activeStep === "project" && <div id="project" className="project-group">
          <div className="group-heading"><span className="eyebrow">02 / TARGET</span><h2>프로젝트 선택/분석</h2></div>
          <p className="section-note">workspace 대상은 운영자가 서버 시작 전에 지정한 루트 아래로 제한됩니다. 브라우저에서 임의의 절대 경로를 선택할 수 없습니다.</p>
          {setupStatus?.mode === "workspace" && setupStatus.configured ? (
            <Card as="section" aria-label="프로젝트 분석" className="surface workspace-run">
              <CardHeader className="section-head"><h2>프로젝트 분석</h2><p className="section-note">저장한 설정으로 허용 루트 안의 프로젝트를 분석합니다.</p></CardHeader>
              <CardContent className="workspace-fields">
                <Field className="workspace-path"><FieldLabel htmlFor="repo-path">저장소 상대 경로</FieldLabel>
                  <Input id="repo-path" value={repoPath} maxLength={512} spellCheck={false} autoComplete="off" placeholder="비워두면 서버의 기본 저장소 루트"
                    onChange={(event) => setRepoPath(event.target.value)} />
                </Field>
                <p className="section-note">서버의 허용 루트 기준 상대 경로입니다. 비워두면 기본 저장소 루트를 분석합니다.</p>
                <Button type="button" size="lg" disabled={run.phase === "running"} onClick={handleRun}>프로젝트 분석</Button>
              </CardContent>
            </Card>
          ) : (
            <Card className="surface unavailable-panel"><strong>프로젝트 분석을 시작하려면 서버를 workspace 모드로 실행하세요</strong><p className="section-note">{workspaceMode ? "연결 설정을 저장한 다음 다시 시도해 주세요." : "연결 설정에서 제공자 정보를 저장한 뒤 TRUSTGATE_MODE=workspace와 TRUSTGATE_WORKSPACE_ROOT로 서버를 다시 시작해 주세요."}</p></Card>
          )}
        </div>}

        {activeStep === "skills" && <Card as="section" id="skills" aria-label="에이전트 스킬" className="surface skills-panel">
          <CardHeader className="section-head"><div><span className="eyebrow">03 / AGENTS</span><h2>에이전트 스킬</h2></div><span className="panel-meta">수동 설치 · 자동 실행 없음</span></CardHeader>
          <p className="section-note">각 에이전트의 프로젝트 스킬을 개별적으로 설치합니다. 운영자가 허용 루트를 지정하고 workspace 모드로 서버를 다시 시작해야 합니다. 브라우저는 루트를 지정하지 않습니다.</p>
          {workspaceMode && <p className="section-note">서버 실행 전 <code>TRUSTGATE_WORKSPACE_ROOT</code>와 <code>TRUSTGATE_MODE=workspace</code>를 운영자가 설정했는지 확인하세요. 실제 루트 고정 여부와 설치 가능 여부는 서버가 요청 시 재검증합니다.</p>}
          <div className="agent-grid">{AGENTS.map(({ id, label, detail }) => {
            const state = skills[id] ?? "idle";
            return <div className="agent-row" key={id}>
              <div className="agent-copy"><strong>{label}</strong><span>{detail}</span></div>
              <Button variant="outline" size="sm" type="button" disabled={!workspaceMode || state === "pending" || state === "installed"} onClick={() => handleInstall(id)}>{label} 스킬 설치</Button>
              <p className={`agent-feedback agent-feedback-${state}`} aria-live="polite">
                {state === "pending" ? `${label} 설치 요청 중…` : state === "installed" ? `${label} 설치 완료` : state === "exists" ? `${label} 스킬이 이미 설치되어 있습니다. 기존 파일을 덮어쓰지 않았습니다.` : state === "error" ? `${label} 스킬을 설치하지 못했습니다. 서버 설정을 확인하고 다시 시도하세요.` : !workspaceMode ? "workspace 모드에서만 설치할 수 있습니다." : "명시적으로 설치 버튼을 누를 때만 요청합니다."}
              </p>
            </div>;
          })}</div>
          <p className="section-note skill-caution">Hermes 스킬은 파일 설치만으로 신뢰되지 않습니다. Hermes에서 직접 내용을 검토하고 신뢰를 승인하세요. 에이전트의 재시작이 필요할 수 있으며 이 페이지는 재시작하지 않습니다.</p>
        </Card>}

        {activeStep === "results" && <div id="results" className="results-group"><div className="group-heading"><span className="eyebrow">04 / EVIDENCE</span><h2>결과 확인</h2></div>
        <Card as="section" aria-label="요약 지표" className="surface">
        <CardHeader className="section-head">
          <h2>요약 지표</h2>
          <Badge variant="outline" className={statusClass(badgeTone)}>
            <span aria-hidden="true">{TONE_ICON[badgeTone]}</span>
            {isSuccess ? RESULT_BADGE : hasAttempt ? run.phase === "running" ? "프로젝트 분석 대기 중" : "프로젝트 분석 실패" : "분석 결과 없음"}
          </Badge>
        </CardHeader>
        <ul className="metric-grid">
          {metrics.map((metric) => (
            <li key={metric.label} className="metric">
              <span className="metric-value">{metric.value}</span>
              <span className="metric-label">{metric.label}</span>
              <span className="metric-meta">{metric.meta}</span>
            </li>
          ))}
        </ul>
        <p className="section-foot">{isSuccess ? RESULT_METRIC_FOOT : hasAttempt ? "프로젝트 실행 결과가 없어 지표를 표시할 수 없습니다." : "프로젝트 분석을 실행하면 여기서 지표를 계산합니다."}</p>
      </Card>

      <Card as="section" aria-label="분석 흐름" className="surface flow">
        <CardHeader className="section-head">
          <h2>분석 흐름</h2>
          <p className="section-note">
            {isSuccess
              ? "방금 실행한 workspace 프로젝트 분석의 단계별 결과입니다."
              : hasAttempt ? "프로젝트 분석 단계의 결과가 아직 없습니다." : "프로젝트 분석을 실행하면 단계마다 판정 근거가 남습니다."}
          </p>
        </CardHeader>
        {stages.map((stage) => (
          <Card as="article" size="sm" key={stage.id} className="card">
            <h3 className="card-title">{stage.title}</h3>
            <Badge variant="outline" className={statusClass(stage.tone)}>
              <span aria-hidden="true">{TONE_ICON[stage.tone]}</span>
              {stage.statusLabel}
            </Badge>
            <p className="card-body">{stage.detail}</p>
            <p className="card-meta">{stage.meta}</p>
          </Card>
        ))}
        {!isSuccess && <p className="section-note">분석 결과 없음 · 완료된 단계가 없습니다.</p>}
      </Card>

      <Card as="section" aria-label="실행 증거" className="surface evidence">
        <CardHeader className="section-head">
          <h2>실행 증거</h2>
          <p className="section-note">
            {isSuccess
              ? "첫 테스트의 요청과 격리 실행 결과, 그리고 판정입니다."
              : "프로젝트 분석 결과가 없어 비교할 수 없습니다."}
          </p>
        </CardHeader>
        {evidence.map((item) => (
          <Card as="article" size="sm" key={item.title} className="card">
            <h3 className="card-title">{item.title}</h3>
            <Badge variant="outline" className={statusClass(item.tone)}>
              <span aria-hidden="true">{TONE_ICON[item.tone]}</span>
              {item.statusLabel}
            </Badge>
            <pre className="evidence-body">
              <code>{item.body}</code>
            </pre>
            <p className="card-meta">{item.caption}</p>
          </Card>
        ))}
        {!isSuccess && <p className="section-note">실행 증거 없음 · 결과가 도착하면 표시됩니다.</p>}
      </Card>
        </div>}

      <footer className="app-footer">
        <section className="footer-block" aria-label="설정 바로가기">
          <h2>연결 설정</h2>
          <Button variant="outline" size="sm" type="button" onClick={() => navigate("setup")}>설정</Button>
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
    </div>
  );
}
