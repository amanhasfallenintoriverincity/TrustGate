import { describe, expect, it, vi, type Mock } from "vitest";

import { startFixtureRun, type FetchLike, type RunResponse } from "./api";

/**
 * 실제 fixture 응답(2026-09-22 캡처, 오케스트레이터 fixture 모드 201)에서 가져온 최소 골격입니다.
 * 필드 이름은 orchestrator report.ts의 RunReport와 정확히 같아야 합니다.
 */
const FIXTURE_PAYLOAD = {
  runId: "run-1",
  provider: "fixture",
  model: "trustgate-fixture-plan",
  reviewedFiles: ["apps/demo-target/src/server.ts", "apps/demo-target/src/store.ts"],
  hypotheses: [
    {
      id: "price-authority",
      title: "Server must own item prices instead of trusting the client",
      category: "price-tampering",
      severity: "high",
      tests: [
        {
          id: "negative-price",
          request: { method: "POST", path: "/api/purchase", body: { itemId: "sword", price: -100 } },
          vulnerableResult: {
            runId: "spec-negative-price",
            hypothesisId: "price-authority",
            verdict: "CONFIRMED",
            executed: true,
            evidence: [{ kind: "status", expected: 400, actual: 200 }],
          },
          patchedResult: {
            runId: "spec-negative-price",
            hypothesisId: "price-authority",
            verdict: "BLOCKED",
            executed: true,
            evidence: [],
          },
          regressionVerdict: "FIXED",
        },
      ],
      regressionVerdict: "FIXED",
    },
  ],
  vulnerableResults: [],
  patchedResults: [],
  regressionVerdict: "FIXED",
  durations: { totalMs: 1840, ocrMs: 210, planningMs: 640, vulnerableMs: 470, patchedMs: 520 },
  source: "fixture",
} as const;

/**
 * 2026-09-22 실서버 캡처 원문(오케스트레이터 fixture 모드, HTTP 201):
 *   curl -s -X POST http://127.0.0.1:8787/api/runs -H 'content-type: application/json' \
 *     -d '{"source":"fixture"}'
 * 위 골격을 손으로 줄인 값이 아니라 서버가 실제로 돌려준 필드 구성(가설 evidence·테스트
 * assertions·vulnerableResults/patchedResults 포함)을 그대로 담았습니다. 가드가 정상
 * 응답을 막지 않는지, 즉 오버 밸리데이션이 없는지를 고정하는 회귀 자산입니다.
 * 들여쓰기와 줄바꿈만 정리했고 직렬화 길이는 캡처와 같은 3474B입니다(LIVE_FIXTURE_BYTES).
 * 값 안에 `\"` 이스케이프가 있어 String.raw로 원문을 그대로 보존합니다.
 */
const LIVE_FIXTURE_RESPONSE_JSON = String.raw`
  {
    "runId": "run-8ed2f092-e4cb-4bae-8453-45ba56b2b516",
    "provider": "fixture",
    "model": "trustgate-fixture-plan",
    "reviewedFiles": [
      "apps/demo-target/src/server.ts",
      "apps/demo-target/src/store.ts"
    ],
    "hypotheses": [
      {
        "id": "price-authority",
        "title": "Server must own item prices instead of trusting the client",
        "category": "price-tampering",
        "severity": "high",
        "evidence": [
          {
            "file": "apps/demo-target/src/store.ts",
            "line": 7,
            "excerpt": "const price = request.body.price;"
          }
        ],
        "tests": [
          {
            "id": "negative-price",
            "request": {
              "method": "POST",
              "path": "/api/purchase",
              "body": {
                "itemId": "sword",
                "price": -100
              }
            },
            "assertions": [
              {
                "kind": "status",
                "equals": 400
              },
              {
                "kind": "state-delta",
                "key": "balance",
                "equals": 0
              }
            ],
            "vulnerableResult": {
              "runId": "spec-negative-price",
              "hypothesisId": "price-authority",
              "verdict": "CONFIRMED",
              "executed": true,
              "evidence": [
                {
                  "kind": "status",
                  "expected": 400,
                  "actual": 200
                }
              ]
            },
            "patchedResult": {
              "runId": "spec-negative-price",
              "hypothesisId": "price-authority",
              "verdict": "BLOCKED",
              "executed": true,
              "evidence": []
            },
            "regressionVerdict": "FIXED"
          },
          {
            "id": "oversized-quantity",
            "request": {
              "method": "POST",
              "path": "/api/purchase",
              "body": {
                "itemId": "shield",
                "quantity": 99
              }
            },
            "assertions": [
              {
                "kind": "status",
                "equals": 400
              },
              {
                "kind": "state-delta",
                "key": "inventoryCount",
                "equals": 3
              }
            ],
            "vulnerableResult": {
              "runId": "spec-oversized-quantity",
              "hypothesisId": "price-authority",
              "verdict": "CONFIRMED",
              "executed": true,
              "evidence": [
                {
                  "kind": "status",
                  "expected": 400,
                  "actual": 201
                }
              ]
            },
            "patchedResult": {
              "runId": "spec-oversized-quantity",
              "hypothesisId": "price-authority",
              "verdict": "BLOCKED",
              "executed": true,
              "evidence": []
            },
            "regressionVerdict": "FIXED"
          }
        ],
        "regressionVerdict": "FIXED"
      },
      {
        "id": "ownership-check",
        "title": "Purchase must reject items owned by another actor",
        "category": "ownership-bypass",
        "severity": "critical",
        "evidence": [
          {
            "file": "apps/demo-target/src/server.ts",
            "line": 42,
            "excerpt": "const actorId = request.headers[\"x-actor-id\"];"
          }
        ],
        "tests": [
          {
            "id": "foreign-item",
            "request": {
              "method": "POST",
              "path": "/api/purchase",
              "body": {
                "itemId": "relic",
                "quantity": 1
              }
            },
            "assertions": [
              {
                "kind": "status",
                "equals": 403
              },
              {
                "kind": "state-delta",
                "key": "balance",
                "equals": 0
              }
            ],
            "vulnerableResult": {
              "runId": "spec-foreign-item",
              "hypothesisId": "ownership-check",
              "verdict": "CONFIRMED",
              "executed": true,
              "evidence": [
                {
                  "kind": "status",
                  "expected": 403,
                  "actual": 200
                }
              ]
            },
            "patchedResult": {
              "runId": "spec-foreign-item",
              "hypothesisId": "ownership-check",
              "verdict": "BLOCKED",
              "executed": true,
              "evidence": []
            },
            "regressionVerdict": "FIXED"
          }
        ],
        "regressionVerdict": "FIXED"
      }
    ],
    "vulnerableResults": [
      {
        "runId": "spec-negative-price",
        "hypothesisId": "price-authority",
        "verdict": "CONFIRMED",
        "executed": true,
        "evidence": [
          {
            "kind": "status",
            "expected": 400,
            "actual": 200
          }
        ]
      },
      {
        "runId": "spec-oversized-quantity",
        "hypothesisId": "price-authority",
        "verdict": "CONFIRMED",
        "executed": true,
        "evidence": [
          {
            "kind": "status",
            "expected": 400,
            "actual": 201
          }
        ]
      },
      {
        "runId": "spec-foreign-item",
        "hypothesisId": "ownership-check",
        "verdict": "CONFIRMED",
        "executed": true,
        "evidence": [
          {
            "kind": "status",
            "expected": 403,
            "actual": 200
          }
        ]
      }
    ],
    "patchedResults": [
      {
        "runId": "spec-negative-price",
        "hypothesisId": "price-authority",
        "verdict": "BLOCKED",
        "executed": true,
        "evidence": []
      },
      {
        "runId": "spec-oversized-quantity",
        "hypothesisId": "price-authority",
        "verdict": "BLOCKED",
        "executed": true,
        "evidence": []
      },
      {
        "runId": "spec-foreign-item",
        "hypothesisId": "ownership-check",
        "verdict": "BLOCKED",
        "executed": true,
        "evidence": []
      }
    ],
    "regressionVerdict": "FIXED",
    "durations": {
      "totalMs": 1840,
      "ocrMs": 210,
      "planningMs": 640,
      "vulnerableMs": 470,
      "patchedMs": 520
    },
    "source": "fixture"
  }
`;

const LIVE_FIXTURE_BYTES = 3474;
const LIVE_FIXTURE_RUN_ID = "run-8ed2f092-e4cb-4bae-8453-45ba56b2b516";

/** 매 테스트가 캡처 원문을 독립적으로 망가뜨릴 수 있도록 매번 새 객체로 풉니다. */
const livePayload = (): LivePayload => JSON.parse(LIVE_FIXTURE_RESPONSE_JSON) as LivePayload;

/** 캡처를 훑어 한 필드씩만 망가뜨리기 위한 느슨한 뷰입니다(캡처는 계약 밖 데이터로 취급). */
type LiveHypothesis = { tests?: unknown; [key: string]: unknown };
type LiveTest = { request?: Record<string, unknown> | undefined; [key: string]: unknown };
type LivePayload = {
  runId: unknown;
  provider: unknown;
  model: unknown;
  reviewedFiles: unknown;
  hypotheses?: LiveHypothesis[] | undefined;
  durations?: Record<string, unknown> | undefined;
  regressionVerdict?: unknown;
  [key: string]: unknown;
};

const firstHypothesis = (payload: LivePayload): LiveHypothesis => {
  const hypothesis = payload.hypotheses?.[0];
  if (hypothesis === undefined) throw new Error("캡처 payload에 가설이 없습니다");
  return hypothesis;
};

const firstTest = (payload: LivePayload): LiveTest => {
  const tests = firstHypothesis(payload).tests;
  const test = Array.isArray(tests) ? (tests[0] as LiveTest | undefined) : undefined;
  if (test === undefined) throw new Error("캡처 payload에 테스트가 없습니다");
  return test;
};

const jsonFetcher = (payload: unknown, status: number): Mock<FetchLike> =>
  vi.fn<FetchLike>(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );

describe("startFixtureRun 요청 모양", () => {
  it("POST /api/runs로 fixture 소스를 보내고 201 응답을 파싱한다", async () => {
    const fetcher = jsonFetcher(FIXTURE_PAYLOAD, 201);

    const report: RunResponse = await startFixtureRun(fetcher);

    expect(report).toMatchObject({ runId: "run-1", source: "fixture", regressionVerdict: "FIXED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("/api/runs");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(init?.body).toBe(JSON.stringify({ source: "fixture" }));
  });

  it("성공 응답의 중첩 판정을 타입 그대로 노출한다", async () => {
    const report = await startFixtureRun(jsonFetcher(FIXTURE_PAYLOAD, 201));

    expect(report.hypotheses[0]?.tests[0]?.regressionVerdict).toBe("FIXED");
    expect(report.hypotheses[0]?.tests[0]?.vulnerableResult.verdict).toBe("CONFIRMED");
    expect(report.durations.totalMs).toBe(1840);
  });
});

describe("startFixtureRun 오류 문구", () => {
  it.each([
    [409, "이미 실행 중인 분석이 있습니다"],
    [400, "요청이 거부되었습니다"],
    [500, "분석 실행이 실패했습니다"],
    [503, "실행 환경을 사용할 수 없습니다"],
  ])("%i 상태를 고정 한국어 문구 예외로 바꾼다", async (status, message) => {
    const fetcher = jsonFetcher({ error: "raw server text" }, status);

    await expect(startFixtureRun(fetcher)).rejects.toThrow(message);
  });

  it("목록에 없는 상태는 상태 코드만 담은 일반 문구로 알린다", async () => {
    await expect(startFixtureRun(jsonFetcher({ error: "nope" }, 429))).rejects.toThrow(
      "실행이 실패했습니다 (HTTP 429)",
    );
  });

  it("서버가 보낸 본문 문자열을 오류 메시지에 노출하지 않는다", async () => {
    const fetcher = jsonFetcher({ error: "run already in progress at /srv/secret" }, 409);

    await expect(startFixtureRun(fetcher)).rejects.toThrow(
      expect.objectContaining({ message: "이미 실행 중인 분석이 있습니다" }) as Error,
    );
    await expect(startFixtureRun(fetcher)).rejects.not.toThrow(/secret/);
  });
});

describe("startFixtureRun 네트워크 실패", () => {
  it("fetch가 TypeError로 실패하면 고정 한국어 문구로 바꾼다", async () => {
    const fetcher = vi.fn<FetchLike>(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(startFixtureRun(fetcher)).rejects.toThrow("분석 서버에 연결하지 못했습니다");
  });

  it("브라우저 원문 영어 문구를 오류 메시지에 노출하지 않는다", async () => {
    const fetcher = vi.fn<FetchLike>(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(startFixtureRun(fetcher)).rejects.not.toThrow(/Failed to fetch/);
  });

  it("Error가 아닌 값으로 실패해도 같은 고정 문구를 쓴다", async () => {
    const fetcher = vi.fn<FetchLike>(async () => {
      throw "network down";
    });

    await expect(startFixtureRun(fetcher)).rejects.toThrow("분석 서버에 연결하지 못했습니다");
  });

  it("전송 중단(AbortError)도 연결 실패 문구로 알린다", async () => {
    const fetcher = vi.fn<FetchLike>(async () => {
      throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    });

    await expect(startFixtureRun(fetcher)).rejects.toThrow("분석 서버에 연결하지 못했습니다");
  });
});

describe("startFixtureRun 응답 가드", () => {
  it("JSON이 아니면 형식 오류로 알린다", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response("<html>nope</html>", { status: 201 }));

    await expect(startFixtureRun(fetcher)).rejects.toThrow("응답 형식이 올바르지 않습니다");
  });

  it("runId가 문자열이 아니면 거부한다", async () => {
    const fetcher = jsonFetcher({ ...FIXTURE_PAYLOAD, runId: 42 }, 201);

    await expect(startFixtureRun(fetcher)).rejects.toThrow("응답 형식이 올바르지 않습니다");
  });

  it("hypotheses가 배열이 아니면 거부한다", async () => {
    const fetcher = jsonFetcher({ ...FIXTURE_PAYLOAD, hypotheses: { length: 0 } }, 201);

    await expect(startFixtureRun(fetcher)).rejects.toThrow("응답 형식이 올바르지 않습니다");
  });

  it("JSON 배열처럼 객체가 아닌 응답을 거부한다", async () => {
    const fetcher = jsonFetcher([FIXTURE_PAYLOAD], 201);

    await expect(startFixtureRun(fetcher)).rejects.toThrow("응답 형식이 올바르지 않습니다");
  });

  it("null 본문을 거부한다", async () => {
    const fetcher = jsonFetcher(null, 201);

    await expect(startFixtureRun(fetcher)).rejects.toThrow("응답 형식이 올바르지 않습니다");
  });
});

describe("startFixtureRun 렌더 경계 가드", () => {
  it("실서버 fixture 201 응답 원문을 그대로 통과시킨다", async () => {
    // 직렬화 길이를 함께 고정해, 캡처를 옮기며 필드를 흘린 채로 테스트가 통과하는 일을 막습니다.
    expect(JSON.stringify(JSON.parse(LIVE_FIXTURE_RESPONSE_JSON)).length).toBe(LIVE_FIXTURE_BYTES);

    const report = await startFixtureRun(jsonFetcher(livePayload(), 201));

    expect(report.runId).toBe(LIVE_FIXTURE_RUN_ID);
    expect(report.reviewedFiles).toHaveLength(2);
    expect(report.hypotheses.flatMap(({ tests }) => tests)).toHaveLength(3);
    expect(report.durations.totalMs).toBe(1840);
  });

  it("뷰가 읽지 않는 집계 필드는 검사하지 않는다", async () => {
    // 가드는 렌더 경계입니다. 전체 계약 검증은 오케스트레이터가 하고, 여기서 그 일을
    // 대신 하면 유효한 응답을 막을 위험만 커집니다(오버 밸리데이션 금지).
    const payload = livePayload();
    payload.vulnerableResults = "nope";
    payload.patchedResults = [{ verdict: 7 }];
    payload.source = null;

    await expect(startFixtureRun(jsonFetcher(payload, 201))).resolves.toMatchObject({
      runId: LIVE_FIXTURE_RUN_ID,
    });
  });

  /**
   * 리뷰어가 실제로 재현한 2xx 깨진 바디 네 형태입니다. 넷 다 렌더 중 TypeError를 내
   * 흰 화면으로 이어졌습니다(`reviewedFiles.length`·`tests.map`·`reviewedFiles.join`).
   */
  it.each([
    ["runId와 빈 hypotheses만 있는 바디", { runId: "run-1", hypotheses: [] }],
    ["빈 객체 하나뿐인 가설", { ...livePayload(), hypotheses: [{}] }],
    ["문자열로 온 reviewedFiles", { ...livePayload(), reviewedFiles: "nope" }],
    [
      "배열이 아닌 tests",
      { ...livePayload(), hypotheses: [{ ...firstHypothesis(livePayload()), tests: "nope" }] },
    ],
  ])("리뷰 재현 · %s → 형식 오류로 거부한다", async (_name, payload) => {
    await expect(startFixtureRun(jsonFetcher(payload, 201))).rejects.toThrow(
      "응답 형식이 올바르지 않습니다",
    );
  });

  /**
   * 캡처 원문에서 한 필드씩만 망가뜨린 표입니다. `undefined`는 JSON.stringify가 키 자체를
   * 지우므로 "필드 없음"을, 나머지는 "타입 불일치"를 검사합니다.
   */
  const DAMAGED_PAYLOADS: readonly {
    readonly name: string;
    readonly damage: (payload: LivePayload) => void;
  }[] = [
    { name: "runId 없음", damage: (payload) => (payload.runId = undefined) },
    { name: "provider가 숫자", damage: (payload) => (payload.provider = 7) },
    { name: "model 없음", damage: (payload) => (payload.model = undefined) },
    { name: "reviewedFiles가 문자열", damage: (payload) => (payload.reviewedFiles = "nope") },
    {
      name: "reviewedFiles 항목이 문자열이 아님",
      damage: (payload) => (payload.reviewedFiles = ["apps/demo-target/src/server.ts", 42]),
    },
    { name: "hypotheses 없음", damage: (payload) => (payload.hypotheses = undefined) },
    { name: "hypotheses가 빈 객체 배열", damage: (payload) => (payload.hypotheses = [{}]) },
    {
      name: "가설 id가 없음",
      damage: (payload) => (firstHypothesis(payload).id = undefined),
    },
    {
      name: "가설 title이 숫자",
      damage: (payload) => (firstHypothesis(payload).title = 12),
    },
    {
      name: "가설 category 없음",
      damage: (payload) => (firstHypothesis(payload).category = undefined),
    },
    {
      name: "가설 severity가 숫자",
      damage: (payload) => (firstHypothesis(payload).severity = 3),
    },
    {
      name: "가설 regressionVerdict가 숫자",
      damage: (payload) => (firstHypothesis(payload).regressionVerdict = 1),
    },
    { name: "tests가 배열이 아님", damage: (payload) => (firstHypothesis(payload).tests = "nope") },
    { name: "테스트 id 없음", damage: (payload) => (firstTest(payload).id = undefined) },
    { name: "테스트 request 없음", damage: (payload) => (firstTest(payload).request = undefined) },
    {
      name: "request.method가 숫자",
      damage: (payload) => {
        const test = firstTest(payload);
        test.request = { ...(test.request ?? {}), method: 7 };
      },
    },
    {
      name: "request.path 없음",
      damage: (payload) => (firstTest(payload).request = { method: "POST" }),
    },
    {
      name: "vulnerableResult 없음",
      damage: (payload) => (firstTest(payload).vulnerableResult = undefined),
    },
    {
      name: "patchedResult.verdict가 숫자",
      damage: (payload) => {
        const test = firstTest(payload);
        test.patchedResult = { ...(test.patchedResult as Record<string, unknown>), verdict: 7 };
      },
    },
    {
      name: "evidence가 배열이 아님",
      damage: (payload) =>
        (firstTest(payload).vulnerableResult = {
          verdict: "CONFIRMED",
          executed: true,
          evidence: "nope",
        }),
    },
    {
      name: "evidence 항목이 null",
      damage: (payload) =>
        (firstTest(payload).vulnerableResult = {
          verdict: "CONFIRMED",
          executed: true,
          evidence: [null],
        }),
    },
    {
      name: "테스트 regressionVerdict가 숫자",
      damage: (payload) => (firstTest(payload).regressionVerdict = 2),
    },
    {
      name: "report regressionVerdict가 숫자",
      damage: (payload) => (payload.regressionVerdict = 2),
    },
    { name: "durations 없음", damage: (payload) => (payload.durations = undefined) },
    {
      name: "durations.totalMs가 문자열",
      damage: (payload) => (payload.durations = { totalMs: "1840" }),
    },
  ];

  it.each(DAMAGED_PAYLOADS)("$name → 형식 오류로 거부한다", async ({ damage }) => {
    const payload = livePayload();
    damage(payload);

    await expect(startFixtureRun(jsonFetcher(payload, 201))).rejects.toThrow(
      "응답 형식이 올바르지 않습니다",
    );
  });
});
