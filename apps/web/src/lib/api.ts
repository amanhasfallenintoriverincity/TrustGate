/**
 * TrustGate 실행 API 클라이언트.
 *
 * 오케스트레이터(`apps/orchestrator`)의 `POST /api/runs` 계약만 다룹니다.
 * - 요청: `{ "source": "fixture" }` (content-type: application/json)
 * - 성공: 201 + `RunReport & { source }` (`cache-control: no-store`)
 * - 오류: 400/409/500/503 고정 바디. 바디 문자열은 신뢰 경계 밖이라 그대로 노출하지 않고
 *   상태 코드별 고정 한국어 문구로 바꿉니다.
 *
 * 타입은 orchestrator 소스의 `report.ts`/`contracts` 구조에서 웹이 실제로 읽는 필드만
 * 서브셋으로 옮긴 것입니다. 워크스페이스 패키지를 직접 import하면 웹 번들에 Node 의존성이
 * 따라오므로 필드 이름만 정확히 일치시키고 로컬에 정의합니다.
 */

/** 테스트가 진짜 `Response`를 돌려줄 수 있도록 fetch 표면을 좁힌 타입입니다. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 수정 전/수정 후 실행 판정. `contracts`의 executionResultSchema와 같은 값입니다. */
export type ExecutionVerdict = "CONFIRMED" | "BLOCKED" | "UNVERIFIED" | "ERROR";

/** 패치 회귀 판정. `verdict.ts`의 RegressionVerdict와 같은 값입니다. */
export type RegressionVerdict = "FIXED" | "STILL_VULNERABLE" | "NOT_REPRODUCED" | "UNVERIFIED";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ExecutionEvidence = {
  readonly kind: string;
  readonly expected: JsonValue;
  readonly actual: JsonValue;
};

export type ExecutionResult = {
  readonly runId: string;
  readonly hypothesisId: string;
  readonly verdict: ExecutionVerdict;
  readonly executed: boolean;
  readonly evidence: readonly ExecutionEvidence[];
};

export type RunRequestSpec = {
  readonly method: string;
  readonly path: string;
  readonly body?: JsonValue;
};

export type RunTest = {
  readonly id: string;
  readonly request: RunRequestSpec;
  readonly vulnerableResult: ExecutionResult;
  readonly patchedResult: ExecutionResult;
  readonly regressionVerdict: RegressionVerdict;
};

export type RunHypothesis = {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly severity: string;
  readonly tests: readonly RunTest[];
  readonly regressionVerdict: RegressionVerdict;
};

export type RunDurations = {
  readonly totalMs: number;
  readonly ocrMs: number;
  readonly planningMs: number;
  readonly vulnerableMs: number;
  readonly patchedMs: number;
};

/** `report.ts`의 `RunReport` 서브셋. 필드 이름은 원본과 정확히 같습니다. */
export type RunReport = {
  readonly runId: string;
  readonly provider: string;
  readonly model: string;
  readonly reviewedFiles: readonly string[];
  readonly hypotheses: readonly RunHypothesis[];
  readonly vulnerableResults: readonly ExecutionResult[];
  readonly patchedResults: readonly ExecutionResult[];
  readonly regressionVerdict: RegressionVerdict;
  readonly durations: RunDurations;
};

/** `server.ts`의 `RunResponse` — 보고서에 실행 소스를 덧붙인 201 응답입니다. */
export type RunResponse = RunReport & { readonly source: string };

const RUN_ENDPOINT = "/api/runs";
const FIXTURE_REQUEST_BODY = JSON.stringify({ source: "fixture" });
const INVALID_RESPONSE_MESSAGE = "응답 형식이 올바르지 않습니다";

/** 서버가 보낸 문장을 그대로 읽지 않고 상태 코드별 고정 문구만 씁니다. */
const STATUS_MESSAGES: Readonly<Record<number, string>> = {
  400: "요청이 거부되었습니다",
  409: "이미 실행 중인 분석이 있습니다",
  500: "분석 실행이 실패했습니다",
  503: "실행 환경을 사용할 수 없습니다",
};

const failureMessage = (status: number): string =>
  STATUS_MESSAGES[status] ?? `실행이 실패했습니다 (HTTP ${status})`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 최소 런타임 가드: 뷰가 읽는 최상위 필드(`runId` 문자열, `hypotheses` 배열)만 확인합니다.
 * 전 필드 검증은 오케스트레이터의 몫이고, 여기서는 렌더 중 예외를 막는 경계만 세웁니다.
 */
const parseRunResponse = (value: unknown): RunResponse => {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    !Array.isArray(value.hypotheses)
  ) {
    throw new Error(INVALID_RESPONSE_MESSAGE);
  }
  return value as unknown as RunResponse;
};

/**
 * fixture 분석을 실행하고 최종 보고서를 돌려줍니다.
 *
 * `fetcher`는 기본값이 전역 `fetch`입니다. dev 서버에서는 vite의 `/api` 프록시가
 * 오케스트레이터로 넘기므로 절대 URL이 필요 없습니다.
 */
export const startFixtureRun = async (
  fetcher: FetchLike = (input, init) => fetch(input, init),
): Promise<RunResponse> => {
  const response = await fetcher(RUN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: FIXTURE_REQUEST_BODY,
  });

  if (!response.ok) throw new Error(failureMessage(response.status));

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(INVALID_RESPONSE_MESSAGE);
  }

  return parseRunResponse(payload);
};
