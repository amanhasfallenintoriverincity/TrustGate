// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "postcss";
import type { AtRule, Container, Declaration, Document, Rule } from "postcss";
import { describe, expect, it } from "vitest";

// ── 이 파일의 지위(한계 선언) ────────────────────────────────────────────────
// jsdom에는 레이아웃 엔진이 없어 렌더 폭·스크롤 폭·접근성 트리를 측정할 수 없습니다.
// 그래서 여기서는 360px 가로 오버플로와 빈 라이브 리전 회귀를 "소스 불변식"으로
// 조기 경보만 합니다. 권위 게이트는 CDP 실브라우저 프로브입니다(2026-09-22 실측, 고정
// 360px 레이아웃 뷰포트 · document.documentElement.scrollWidth):
//   · 안내 요소에 96자 토큰: overflow-wrap:anywhere → 360px / break-word·normal → 740px.
//   · 줄바꿈 그룹이 거는 <p>에 300자 토큰: anywhere → 360px / normal → 2509px.
//   · 빈 리전에 display:none·visibility:hidden → AX role=status 1→0(노드 자체가 사라짐),
//     1px + clip-path 조합은 1 유지.
// 정적 계약이 green이어도 실제 지오메트리·AX는 깨질 수 있고, 그 반대도 가능합니다.
//
// 정적으로 잡지 못하는 것(의도한 한계):
//   · `all: revert`/`all: unset` 같은 캐스케이드 무력화의 일반형. 아래 all 검사는
//     줄바꿈 대상 요소에 한정한 좁은 그물입니다(전부 잡으려면 실브라우저 계산값 비교).
//   · 런타임 지오메트리: 실제 주입 문자열 길이, 폰트 대체, 부모 폭, 이미지 크기.
//   · 다른 파일·인라인 스타일·스크립트로 주입되는 스타일.
//
// 파서는 정규식이 아니라 postcss AST입니다. 정규식 파서는 CSS 중첩
// (`.app-shell { … .action-notice:empty { display: none } }`), prefix 셀렉터
// (`.app-header .action-notice:empty`), 두 번째 규칙, 중복 선언 같은 관용적 CSS에
// 조용히 우회되어 실제 회귀를 green으로 통과시켰습니다.
//
// 셀렉터 판정은 접미(`^`) 앵커 없이 서브스트링/정규 매치로만 합니다. `.app-header
// .action-notice:empty`처럼 감싸진 형태도 같은 강도로 검사하기 위해서입니다.
// 값은 마지막 선언이 이깁니다(같은 속성을 두 번 쓰면 뒤가 계산값).
//
// `?raw` import는 이 Vitest 설정에서 빈 문자열로 스텁되므로 파일을 직접 읽습니다.
const CSS_PATH = fileURLToPath(new URL("./index.css", import.meta.url));
const cssSource = readFileSync(CSS_PATH, "utf8");
const root = parse(cssSource, { from: CSS_PATH });

type DeclaredValue = {
  readonly value: string;
  readonly important: boolean;
};

type RuleView = {
  /** 규칙 원문 셀렉터(공백 정규화). prefix·중첩 형태까지 그대로 남습니다. */
  readonly selector: string;
  /** 규칙 대상 판정용 셀렉터 목록. 선행 `&`/결합자는 떼고 순수 중첩 별칭은 부모에서 물려받습니다. */
  readonly selectors: readonly string[];
  /** 속성 → 마지막 선언(중복 선언이 있으면 뒤가 이깁니다). */
  readonly decls: ReadonlyMap<string, DeclaredValue>;
  /** 조상 at-rule 체인(안쪽 → 바깥쪽). @media print 예외 판정용. */
  readonly atRules: readonly string[];
  /** 조상 규칙 셀렉터 체인(안쪽 → 바깥쪽). 중첩 투명성 판정용. */
  readonly parentRules: readonly string[];
};

const normalizeText = (text: string): string => text.replace(/\s+/g, " ").trim();

/** `word-wrap`은 `overflow-wrap`의 레거시 별칭이라 같은 속성으로 계산합니다. */
const propertyKey = (property: string): string => {
  const key = property.trim().toLowerCase();
  return key === "word-wrap" ? "overflow-wrap" : key;
};

/** 선행 `&`와 결합자를 떼어 요소 리터럴과 직접 비교할 수 있게 합니다(`& > span` → `span`). */
const stripNesting = (selector: string): string =>
  normalizeText(selector.replace(/&/g, " ")).replace(/^(?:[>+~]\s*)+/, "").trim();

/** 중첩을 그대로 통과시키는 부모 셀렉터(`:where(body) { & span { … } }`는 전역 span과 같은 대상). */
const TRANSPARENT_PARENT = /^(?::where\([\s\S]*\)|:is\([\s\S]*\)|:root|html|body|\*)$/i;

/** 부모 포인터는 Document까지 올라갈 수 있습니다. */
type ParentNode = Document | Container | undefined;

const asRule = (node: ParentNode): Rule | undefined =>
  node !== undefined && node.type === "rule" ? (node as Rule) : undefined;

const selectorsOf = (rule: Rule): readonly string[] => {
  const raw = rule.selectors.map(normalizeText).filter((selector) => selector.length > 0);
  const parentRule = asRule(rule.parent);

  // `.card { & { min-inline-size: 0 } }`처럼 순수 별칭으로만 중첩한 형태는 부모 대상을 그대로 물려받습니다.
  if (raw.length === 1 && raw[0] === "&" && parentRule !== undefined) {
    return selectorsOf(parentRule);
  }

  return raw.map(stripNesting).filter((selector) => selector.length > 0);
};

const ancestorsOf = (
  rule: Rule,
): { readonly atRules: readonly string[]; readonly parentRules: readonly string[] } => {
  const atRules: string[] = [];
  const parentRules: string[] = [];
  let current: ParentNode = rule.parent;

  while (current !== undefined) {
    if (current.type === "atrule") {
      const atRule = current as AtRule;
      atRules.push(normalizeText(`@${atRule.name} ${atRule.params}`));
    } else if (current.type === "rule") {
      parentRules.push(normalizeText((current as Rule).selector));
    }
    current = current.parent;
  }

  return { atRules, parentRules };
};

const toRuleView = (rule: Rule): RuleView => {
  const decls = new Map<string, DeclaredValue>();

  for (const node of rule.nodes) {
    if (node.type === "decl") {
      decls.set(propertyKey(node.prop), { value: node.value.trim(), important: node.important });
    }
  }

  const { atRules, parentRules } = ancestorsOf(rule);

  return {
    selector: normalizeText(rule.selector),
    selectors: selectorsOf(rule),
    decls,
    atRules,
    parentRules,
  };
};

/** 중첩 규칙도 AST에 그대로 나오므로 walkRules 한 번이면 깊이와 무관하게 전부 수집됩니다. */
const rules: RuleView[] = [];
root.walkRules((rule) => {
  rules.push(toRuleView(rule));
});

const declaredValue = (rule: RuleView, property: string): string | undefined =>
  rule.decls.get(property)?.value.toLowerCase();

/** 노드를 접근성 트리에서 통째로 제거하는 선언(계산값 기준). */
const nodeRemovers = (rule: RuleView): readonly string[] => {
  const offenders: string[] = [];
  if (declaredValue(rule, "display") === "none") {
    offenders.push("display: none");
  }
  if (declaredValue(rule, "visibility") === "hidden") {
    offenders.push("visibility: hidden");
  }
  return offenders;
};

/** `@media print` 안쪽인지 조상 at-rule 체인으로 판정합니다(인쇄에서 숨기는 건 정상). */
const isPrintScoped = (rule: RuleView): boolean =>
  rule.atRules.some((atRule) => /^@media\b/.test(atRule) && /\bprint\b/i.test(atRule));

type RecipeStep = {
  readonly property: string;
  readonly accepts: (value: string) => boolean;
  /** 실패 메시지에 그대로 쓰는 정당 표현 안내. */
  readonly expectation: string;
};

const isOnePixel = (value: string): boolean => value === "1px";
const isZero = (value: string): boolean => value === "0" || value === "0px";
const isInsetHiding = (value: string): boolean =>
  /^inset\(\s*50%(?:\s+50%)?\s*\)$/.test(normalizeText(value));

/** 빈 상태를 렌더한 채 화면에서만 지우는 레시피. 모든 항목이 "유효값"이어야 합니다. */
const HIDDEN_RECIPE: readonly RecipeStep[] = [
  {
    property: "position",
    accepts: (value) => value === "absolute",
    expectation: "position: absolute",
  },
  { property: "inline-size", accepts: isOnePixel, expectation: "inline-size: 1px" },
  { property: "block-size", accepts: isOnePixel, expectation: "block-size: 1px" },
  {
    property: "padding",
    accepts: isZero,
    expectation: "padding: 0(또는 0px)",
  },
  {
    property: "border",
    accepts: (value) => isZero(value) || value === "none",
    expectation: "border: 0(또는 0px·none)",
  },
  {
    property: "overflow",
    accepts: (value) => value === "hidden" || value === "clip",
    expectation: "overflow: hidden(또는 clip)",
  },
  {
    property: "clip-path",
    accepts: isInsetHiding,
    expectation: "clip-path: inset(50%)(또는 inset(50% 50%))",
  },
];

/** 시각적 숨김 레시피의 낱개 재료. `:empty`가 아닌 규칙에 새어 들어오면 안 됩니다. */
const RECIPE_PRIMITIVES: readonly RecipeStep[] = [
  {
    property: "clip-path",
    accepts: (value) => /\binset\(/.test(value),
    expectation: "clip-path: inset(…)",
  },
  { property: "position", accepts: (value) => value === "absolute", expectation: "position: absolute" },
  { property: "inline-size", accepts: isOnePixel, expectation: "inline-size: 1px" },
  { property: "block-size", accepts: isOnePixel, expectation: "block-size: 1px" },
  { property: "width", accepts: isOnePixel, expectation: "width: 1px" },
  { property: "height", accepts: isOnePixel, expectation: "height: 1px" },
];

const unmetSteps = (rule: RuleView, steps: readonly RecipeStep[]): readonly string[] =>
  steps
    .filter((step) => {
      const declared = rule.decls.get(step.property);
      return declared === undefined || !step.accepts(declared.value.toLowerCase());
    })
    .map((step) => step.expectation);

const leakedSteps = (rule: RuleView, steps: readonly RecipeStep[]): readonly string[] =>
  steps
    .filter((step) => {
      const declared = rule.decls.get(step.property);
      return declared !== undefined && step.accepts(declared.value.toLowerCase());
    })
    .map((step) => step.expectation);

const NOTICE_SELECTOR = ".action-notice";
/** `:empty`를 접미 앵커 없이 찾습니다(`:empty-foo` 같은 다른 의사 클래스는 제외). */
const EMPTY_PSEUDO = /:empty(?![-\w])/;

const WRAP_ELEMENT_GROUP: readonly string[] = [
  "h1",
  "h2",
  "h3",
  "p",
  "li",
  "pre",
  "code",
  "span",
  "button",
];

/** 셀렉터 안에서 타입 셀렉터(요소명)만 뽑습니다(`button.action` → `button`, `.status` → 없음). */
const typeSelectors = (selector: string): readonly string[] =>
  selector
    .split(/[\s>+~]+/)
    .map((compound) => /^([a-z][a-z0-9]*)/i.exec(compound)?.[1]?.toLowerCase())
    .filter((name): name is string => name !== undefined);

type MinmaxUsage = {
  /** 실패 메시지용 위치 설명(규칙 셀렉터 · 속성). */
  readonly owner: string;
  readonly firstArgument: string;
};

/**
 * 괄호 균형 스캔으로 `minmax(`의 첫 인자만 정확히 잘라냅니다.
 * 중첩된 `min(210px, 100%)`의 콤마에 속지 않으려면 정규식으로는 부족합니다.
 */
const minmaxFirstArguments = (value: string, owner: string): readonly MinmaxUsage[] => {
  const usages: MinmaxUsage[] = [];
  const needle = "minmax(";

  for (let index = 0; index < value.length; index += 1) {
    if (!value.startsWith(needle, index)) {
      continue;
    }
    // `--my-minmax(` 같은 식별자 연속은 함수 호출이 아닙니다.
    if (/[-\w]/.test(value[index - 1] ?? "")) {
      continue;
    }

    const open = index + needle.length - 1;
    let depth = 0;
    let end = value.length;

    for (let cursor = open; cursor < value.length; cursor += 1) {
      const char = value[cursor];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          end = cursor;
          break;
        }
      } else if (char === "," && depth === 1) {
        end = cursor;
        break;
      }
    }

    usages.push({ owner, firstArgument: value.slice(open + 1, end).trim() });
    index = open;
  }

  return usages;
};

/** 트랙 최소값이 컨테이너 폭까지 줄어들 수 있는가. 맨 고정 길이(`320px`)는 줄어들지 않습니다. */
const isShrinkableMinimum = (firstArgument: string): boolean => {
  const argument = normalizeText(firstArgument).toLowerCase();

  // `min(210px, 100%)`처럼 래핑하면 좁은 화면에서 컨테이너 폭까지 접힙니다.
  if (argument.startsWith("min(")) {
    return true;
  }

  // `0`/`0px`/`auto`는 콘텐츠가 아무리 넓어도 트랙을 0까지 줄일 수 있는 값입니다.
  // (관용적 안전값만 허용합니다. `min-content`·`%`는 계약에 없으면 red — 권위 판정은 CDP 프로브.)
  return argument === "0" || argument === "0px" || argument === "auto";
};

const ownerOf = (declaration: Declaration): string => {
  const parent = declaration.parent;
  if (parent === undefined) {
    return declaration.prop;
  }
  if (parent.type === "rule") {
    return normalizeText((parent as Rule).selector);
  }
  if (parent.type === "atrule") {
    return `@${(parent as AtRule).name}`;
  }
  return declaration.prop;
};

describe("index.css 좁은 화면 계약", () => {
  it("CSS 소스를 실제로 읽어 postcss AST로 파싱했다", () => {
    // 파서가 빈 소스를 상대로 통과하는 가짜 GREEN을 막습니다.
    expect(cssSource.length).toBeGreaterThan(1000);
    expect(rules.length).toBeGreaterThan(20);
  });

  it("줄바꿈 규칙 그룹이 span·button을 포함하고 값을 anywhere로 고정한다", () => {
    const wrappingRules = rules.filter((rule) => rule.decls.has("overflow-wrap"));

    expect(wrappingRules.length, "overflow-wrap 규칙을 찾지 못했습니다").toBeGreaterThan(0);

    // 값은 마지막 선언 기준입니다. `overflow-wrap: anywhere; overflow-wrap: break-word;`처럼
    // 중복 선언으로 되돌리면 계산값이 break-word가 되어 좁은 화면이 다시 밀려납니다.
    for (const rule of wrappingRules) {
      expect(
        declaredValue(rule, "overflow-wrap"),
        `${rule.selector}의 overflow-wrap 유효값(마지막 선언)이 anywhere가 아닙니다`,
      ).toBe("anywhere");
    }

    // 중첩을 그대로 통과시키는 형태(`:where(body) { & span { … } }`)만 리터럴로 인정합니다.
    const wrapped = wrappingRules
      .filter((rule) => rule.parentRules.every((parent) => TRANSPARENT_PARENT.test(parent)))
      .flatMap((rule) => rule.selectors);

    // 기존 대상이 빠지지 않았는지 먼저 고정합니다.
    for (const literal of WRAP_ELEMENT_GROUP) {
      expect(wrapped, `${literal} 리터럴이 줄바꿈 그룹에서 빠졌습니다`).toContain(literal);
    }

    // 클래스 스코프로 축소(`.action-meta span` 등)하면 같은 토큰이 다른 요소로 들어올 때 다시 밀려납니다.
    // 위 toContain은 정확히 요소 리터럴만 인정하므로 축소형은 통과하지 못합니다.
  });

  it("그리드 자식이 줄어들도록 min-inline-size: 0이 선언되어 있다", () => {
    // .app-header/.app-footer만 보던 검사를 카드 표면(.surface·.card 공유 규칙)과
    // .footer-block까지 넓혔습니다. 그룹 셀렉터는 각 셀렉터를 개별로 확인합니다.
    for (const selector of [".app-header", ".app-footer", ".surface", ".card", ".footer-block"]) {
      const declared = rules.filter(
        (rule) => rule.selectors.includes(selector) && rule.decls.has("min-inline-size"),
      );

      expect(declared.length, `${selector}에 min-inline-size 선언이 없습니다`).toBeGreaterThan(0);

      for (const rule of declared) {
        expect(
          declaredValue(rule, "min-inline-size"),
          `${rule.selector}의 min-inline-size 유효값`,
        ).toMatch(/^0(?:px)?$/);
      }
    }
  });

  it("미사용 .evidence-grid 선택자가 제거되고 그리드 트랙이 minmax(min(...))로 고정되어 있다", () => {
    // 셀렉터 어디에도(중첩·prefix 포함) .evidence-grid가 남아 있으면 실패합니다.
    const evidenceGrid = rules
      .map((rule) => rule.selector)
      .filter((selector) => selector.includes(".evidence-grid"));

    expect(evidenceGrid, ".evidence-grid 선택자가 남아 있습니다").toEqual([]);

    // 트랙은 파일 전체에서 검사합니다. 첫 인자가 맨 고정 길이(예: 320px)면 좁은 화면이
    // 트랙 최소폭만큼 밀려납니다. 괄호 균형 스캔이라 중첩 min()의 콤마에 속지 않습니다.
    const usages: MinmaxUsage[] = [];
    root.walkDecls((declaration) => {
      usages.push(
        ...minmaxFirstArguments(
          declaration.value,
          `${ownerOf(declaration)} · ${declaration.prop}`,
        ),
      );
    });

    expect(usages.length, "minmax() 트랙을 찾지 못했습니다").toBeGreaterThan(0);

    for (const usage of usages) {
      expect(
        isShrinkableMinimum(usage.firstArgument),
        `${usage.owner}: minmax(${usage.firstArgument}, …)의 최소 트랙이 줄어들 수 없습니다`,
      ).toBe(true);
    }

    // 그룹 셀렉터에서 한쪽만 지우는 실수를 막기 위해 기대 셀렉터도 개별로 고정합니다.
    const trackSelectors = rules
      .filter((rule) => rule.decls.has("grid-template-columns"))
      .flatMap((rule) => rule.selectors);

    for (const selector of [".metric-grid", ".flow", ".evidence", ".app-footer"]) {
      expect(trackSelectors, `${selector}의 그리드 트랙 규칙을 찾지 못했습니다`).toContain(selector);
    }
  });

  it("줄바꿈 대상 요소에 all: revert/unset으로 캐스케이드를 무력화하지 않는다", () => {
    const CASCADE_REVERTS = new Set(["revert", "revert-layer", "unset", "initial"]);

    // `span { all: revert }` 한 줄이면 위의 overflow-wrap: anywhere 계약이 통째로 무효가 됩니다.
    // 정적 검사의 사정권을 넓히지 않으려고 줄바꿈 그룹 요소를 대상으로 하는 규칙만 봅니다.
    const offenders = rules
      .filter((rule) => CASCADE_REVERTS.has(declaredValue(rule, "all") ?? "\u0000"))
      .filter((rule) =>
        rule.selectors.some((selector) =>
          typeSelectors(selector).some((name) => WRAP_ELEMENT_GROUP.includes(name)),
        ),
      )
      .map((rule) => `${rule.selector} { all: ${declaredValue(rule, "all") ?? ""} }`);

    expect(offenders, "줄바꿈 대상 요소의 캐스케이드가 되돌려집니다").toEqual([]);
  });
});

describe("index.css 빈 라이브 리전 처리", () => {
  it("빈 .action-notice를 display가 아니라 시각적 숨김으로 처리해 AX 트리에 남긴다", () => {
    // 셀렉터 문자열 기준 서브스트링 판정이라 `.app-header .action-notice:empty`나
    // `.app-shell` 중첩 안의 규칙도 같은 강도로 검사됩니다.
    const noticeRules = rules.filter((rule) => rule.selector.includes(NOTICE_SELECTOR));

    expect(noticeRules.length, ".action-notice 규칙을 찾지 못했습니다").toBeGreaterThan(0);

    const screenRules = noticeRules.filter((rule) => !isPrintScoped(rule));
    const emptyRules = screenRules.filter((rule) => EMPTY_PSEUDO.test(rule.selector));
    const baseRules = screenRules.filter((rule) => !EMPTY_PSEUDO.test(rule.selector));

    // 빈 상태 계약과 기본 계약이 화면용으로 각각 존재해야 합니다.
    // (인쇄에서만 선언해 두면 화면에서는 계약이 사라집니다.)
    expect(emptyRules.length, "화면용 .action-notice:empty 규칙을 찾지 못했습니다").toBeGreaterThan(
      0,
    );
    expect(baseRules.length, "화면용 기본 .action-notice 규칙을 찾지 못했습니다").toBeGreaterThan(0);

    // (1) .action-notice를 포함하는 모든 규칙에서 노드 제거 금지(인쇄 매체 예외).
    // display: none·visibility: hidden은 노드를 접근성 트리에서 통째로 빼버립니다.
    for (const rule of screenRules) {
      expect(
        nodeRemovers(rule),
        `${rule.selector}에 노드 제거 선언 금지(AX 트리에서 사라집니다)`,
      ).toEqual([]);
    }

    // (2) `:empty` 규칙은 시각적 숨김 레시피를 유효값으로 갖춰야 합니다.
    for (const rule of emptyRules) {
      expect(
        unmetSteps(rule, HIDDEN_RECIPE),
        `${rule.selector}에 시각적 숨김 레시피가 빠졌습니다`,
      ).toEqual([]);
    }

    // (3) 채워진 규칙(`:empty` 아님)에는 숨김 레시피가 새면 안 됩니다.
    // 두 번째 규칙으로 clip-path를 덧씌워 안내를 가리는 회귀를 막습니다.
    // (기본 규칙의 정확한 display 값은 고정하지 않습니다: flex·grid 같은 동등 표현은 정당합니다.)
    for (const rule of baseRules) {
      expect(
        leakedSteps(rule, RECIPE_PRIMITIVES),
        `${rule.selector}에 시각적 숨김 레시피가 새어 들어갔습니다`,
      ).toEqual([]);
    }
  });
});
