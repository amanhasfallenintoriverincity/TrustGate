/**
 * TrustGate 실행 API 클라이언트.
 *
 * 오케스트레이터(`apps/orchestrator`)의 `POST /api/runs` 계약만 다룹니다.
 * - 요청: `{ "source": "fixture" }` (content-type: application/json)
 * - 성공: 201 + `RunReport & { source }` (`cache-control: no-store`)
 * - 오류: 400/409/500/503 고정 바디. 바디 문자열은 신뢰 경계 밖이라 그대로 노출하지 않고
 *   상태 코드별 고정 한국어 문구로 바꿉니다.
 * - 네트워크 실패: 전송 계층 예외(`TypeError: Failed to fetch`처럼 브라우저마다 다른 원문)도
 *   그대로 흘리지 않고 네트워크 고정 한국어 문구로 바꿉니다.
 * - 2xx 형식 오류: 응답 가드(`isRenderableRunResponse`)가 화면(`App.tsx`)이 읽는 필드와 계약이
 *   요구하는 반향 필드를 확인하고, 하나라도 어긋나면 고정 문구로 알립니다. 렌더 중 `TypeError`로
 *   흰 화면이 되는 일이 없도록 하는 경계이고, 계약 전 필드 검증은 오케스트레이터 몫입니다.
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

/**
 * 렌더 경계 가드(`isRenderableRunResponse`)가 실제로 확인하는 필드만 담은 검증 서브셋입니다.
 * 뷰(`App.tsx`)가 읽는 필드에 더해, 뷰가 읽지는 않지만 계약이 모양을 정하는 반향 필드까지
 * 포함합니다(그 필드들은 `RunHypothesis`/`RunTest`/`ExecutionResult`/`RunDurations` 안에 있습니다).
 */
export type RenderableRunResponse = {
  readonly runId: string;
  readonly provider: string;
  readonly model: string;
  readonly reviewedFiles: readonly string[];
  readonly hypotheses: readonly RunHypothesis[];
  readonly regressionVerdict: RegressionVerdict;
  readonly durations: RunDurations;
};

/**
 * `report.ts`의 `RunReport` 서브셋(= 검증 서브셋 + 화면이 읽지 않는 집계 배열).
 * 필드 이름은 원본과 정확히 같습니다.
 */
export type RunReport = RenderableRunResponse & {
  readonly vulnerableResults: readonly ExecutionResult[];
  readonly patchedResults: readonly ExecutionResult[];
};

/**
 * `server.ts`의 `RunResponse` — 보고서에 실행 소스를 덧붙인 201 응답입니다.
 *
 * 가드가 확인하지 않는 필드는 선택으로 선언합니다: `source`와 집계 배열은 값이 없거나
 * 어긋나도 렌더가 그대로 진행되므로(가드 통과 후 그대로 노출), 필수로 선언하면 타입이 실제
 * 통과 경로보다 강한 보증을 하게 됩니다.
 */
export type RunResponse = RenderableRunResponse & {
  readonly source?: string;
  readonly vulnerableResults?: readonly ExecutionResult[];
  readonly patchedResults?: readonly ExecutionResult[];
};

const RUN_ENDPOINT = "/api/runs";
const FIXTURE_REQUEST_BODY = JSON.stringify({ source: "fixture" });
const INVALID_RESPONSE_MESSAGE = "응답 형식이 올바르지 않습니다";

/**
 * 전송 계층 실패용 고정 문구입니다. `fetch`가 네트워크 단절·DNS 실패·CORS 차단 등에서 던지는
 * 예외는 브라우저마다 문구가 다르고(예: `TypeError: Failed to fetch`) 영어 원문이 그대로
 * 사용자에게 노출되므로, 상태 코드 문구와 같은 방식으로 고정 한국어 문구만 씁니다.
 */
const CONNECTION_MESSAGE = "분석 서버에 연결하지 못했습니다";

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

const isString = (value: unknown): value is string => typeof value === "string";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * 계약의 닫힌 enum입니다. 뷰(`App.tsx`)는 이 판정값으로 한국어 라벨과 색을 찾으므로,
 * 표에 없는 문자열이 들어오면 라벨이 빈 채로 그려집니다. 그래서 문자열 여부만이 아니라
 * 알려진 값인지까지 확인합니다(계약 자체는 `contracts`가 정의합니다).
 */
const EXECUTION_VERDICTS: ReadonlySet<string> = new Set([
  "CONFIRMED",
  "BLOCKED",
  "UNVERIFIED",
  "ERROR",
]);

const REGRESSION_VERDICTS: ReadonlySet<string> = new Set([
  "FIXED",
  "STILL_VULNERABLE",
  "NOT_REPRODUCED",
  "UNVERIFIED",
]);

const isExecutionVerdict = (value: unknown): boolean =>
  isString(value) && EXECUTION_VERDICTS.has(value);

const isRegressionVerdict = (value: unknown): boolean =>
  isString(value) && REGRESSION_VERDICTS.has(value);

/** 근거 한 건. 화면은 `kind` 문구와 두 값의 JSON 직렬화만 씁니다. */
const isExecutionEvidence = (value: unknown): boolean =>
  isRecord(value) && isString(value.kind) && "expected" in value && "actual" in value;

/** 실행 결과. `verdict`/`executed`/`evidence`가 카드 본문 줄이 됩니다. */
const isExecutionResult = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.runId) &&
  isString(value.hypothesisId) &&
  isExecutionVerdict(value.verdict) &&
  typeof value.executed === "boolean" &&
  Array.isArray(value.evidence) &&
  value.evidence.every(isExecutionEvidence);

/**
 * 요청 스펙. 화면은 `method`/`path`를 그대로 쓰고 `body`는 JSON 직렬화만 하므로
 * `body`(선택 필드)의 값 자체는 확인하지 않습니다.
 */
const isRequestSpec = (value: unknown): boolean =>
  isRecord(value) && isString(value.method) && isString(value.path);

const isRunTest = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.id) &&
  isRequestSpec(value.request) &&
  isExecutionResult(value.vulnerableResult) &&
  isExecutionResult(value.patchedResult) &&
  isRegressionVerdict(value.regressionVerdict);

const isRunHypothesis = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.title) &&
  isString(value.category) &&
  isString(value.severity) &&
  isRegressionVerdict(value.regressionVerdict) &&
  Array.isArray(value.tests) &&
  value.tests.every(isRunTest);

const isRunDurations = (value: unknown): boolean =>
  isRecord(value) &&
  isFiniteNumber(value.totalMs) &&
  isFiniteNumber(value.ocrMs) &&
  isFiniteNumber(value.planningMs) &&
  isFiniteNumber(value.vulnerableMs) &&
  isFiniteNumber(value.patchedMs);

/**
 * 렌더 경계 가드입니다. 2xx로 온 바디에서 화면(`App.tsx`)이 읽는 필드와, 계약이 모양을 정하는
 * 반향 필드를 확인합니다. 여기서 통과시키면 렌더 중 `TypeError`가 날 수 없습니다.
 *
 * 확인하는 것
 * - 뷰가 dereference하는 필드: `runId`(상태 문구 보간), `provider`/`model`(단계 meta 보간),
 *   `reviewedFiles`(`length`/`join`), `hypotheses[].id`/`title`, `hypotheses[].tests[]`,
 *   `test.id`, `test.request.method`/`path`, `test.vulnerableResult`/`patchedResult`의
 *   `verdict`/`executed`/`evidence`(`kind`/`expected`/`actual`), `test.regressionVerdict`와
 *   `report.regressionVerdict`(판정 라벨·색 표 인덱싱), `durations.totalMs`.
 * - 뷰가 읽지는 않지만 계약이 요구하는 반향 필드: `hypothesis.regressionVerdict`,
 *   `hypothesis.category`/`severity`, `executionResult.runId`/`hypothesisId`,
 *   `durations.ocrMs`/`planningMs`/`vulnerableMs`/`patchedMs`(숫자 슬롯은 `isFiniteNumber`로
 *   유한한 수인지까지 확인합니다).
 *
 * 확인하지 않는 것(의도한 경계): `source`(전송 메타)와 집계 배열 `vulnerableResults`/
 * `patchedResults`. 셋 다 화면이 읽지 않으므로 어떤 값이 와도 렌더는 그대로 진행되고, 여기서
 * 대신 검증하면 유효한 응답을 막을 위험만 커집니다. `request.body`도 값 자체는 확인하지
 * 않습니다(화면은 직렬화만 하고, 깊은 값은 `App.tsx`의 표시 경로가 고정 문구로 낮춥니다).
 * 전체 계약 검증은 오케스트레이터의 스키마 몫입니다.
 */
const isRenderableRunResponse = (value: unknown): value is RenderableRunResponse =>
  isRecord(value) &&
  isString(value.runId) &&
  isString(value.provider) &&
  isString(value.model) &&
  // `source`(전송 메타)는 화면이 읽지 않습니다. 여기서 확인하지 않는 대표적인 비-렌더 필드입니다.
  Array.isArray(value.reviewedFiles) &&
  value.reviewedFiles.every(isString) &&
  isRegressionVerdict(value.regressionVerdict) &&
  isRunDurations(value.durations) &&
  Array.isArray(value.hypotheses) &&
  value.hypotheses.every(isRunHypothesis);

/**
 * 형식이 어긋나면 `INVALID_RESPONSE_MESSAGE`로 알립니다. 화면은 이 문구를 그대로 보여 주고
 * 지표·증거 카드는 샘플 값으로 남깁니다(흰 화면 대신 읽을 수 있는 문장).
 */
const parseRunResponse = (value: unknown): RunResponse => {
  if (!isRenderableRunResponse(value)) throw new Error(INVALID_RESPONSE_MESSAGE);
  // 가드는 검증 서브셋까지만 좁히므로, 확인하지 않는 선택 필드(`source`·집계 배열)는
  // 통과한 값 그대로 남습니다. 여기서 타입 단언 없이 대입이 성립하는 이유입니다.
  return value;
};

/**
 * fixture 분석을 실행하고 최종 보고서를 돌려줍니다.
 *
 * `fetcher`는 기본값이 전역 `fetch`입니다. dev 서버에서는 vite의 `/api` 프록시가
 * 오케스트레이터로 넘기므로 절대 URL이 필요 없습니다.
 *
 * 전송 계층에서 던져진 예외는 내용을 보지 않고 `CONNECTION_MESSAGE`로만 바꿉니다.
 */
export const startFixtureRun = async (
  fetcher: FetchLike = (input, init) => fetch(input, init),
): Promise<RunResponse> => {
  let response: Response;
  try {
    response = await fetcher(RUN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: FIXTURE_REQUEST_BODY,
    });
  } catch {
    throw new Error(CONNECTION_MESSAGE);
  }

  if (!response.ok) throw new Error(failureMessage(response.status));

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(INVALID_RESPONSE_MESSAGE);
  }

  return parseRunResponse(payload);
};
