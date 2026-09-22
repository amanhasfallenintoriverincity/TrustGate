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
//   · 맨 고정 그리드 트랙(래핑 제거): .app-footer{320px 1fr} → 354 > 345(+9px),
//     .metric-grid{320px 1fr} → 391 > 345(+46px), repeat(auto-fit,320px) → 카드 17px 초과.
// 정적 계약이 green이어도 실제 지오메트리·AX는 깨질 수 있고, 그 반대도 가능합니다.
//
// 정적으로 잡지 못하는 것(의도한 한계):
//   · `all: revert`/`all: unset` 같은 캐스케이드 무력화의 일반형. 아래 all 검사는
//     줄바꿈 대상 요소에 한정한 좁은 그물입니다(전부 잡으려면 실브라우저 계산값 비교).
//   · 정적으로 값이 정해지지 않는 트랙: `calc()`·`clamp()`·`var()`·`min()`/`max()`·
//     `fit-content()`는 허용합니다(예: `min(320px, 1fr)`처럼 실제로는 줄어들지 않는 식도
//     통과). 맨 절대 길이(`320px`·`20rem`·`50vw`)와 그런 트랙이 든 `repeat()`만 잡습니다.
//   · 런타임 지오메트리: 실제 주입 문자열 길이, 폰트 대체, 부모 폭, 이미지 크기.
//   · 다른 파일·인라인 스타일·스크립트로 주입되는 스타일.
//   · 시각적 숨김 레시피 목록(clip-path·position·1px·overflow) 밖의 숨김 기법:
//     `transform`·`opacity`·`filter`·`height: 0` 등은 이 계약의 사정권이 아닙니다.
//
// 파서는 정규식이 아니라 postcss AST입니다. 정규식 파서는 CSS 중첩
// (`.app-shell { … .action-notice:empty { display: none } }`), prefix 셀렉터
// (`.app-header .action-notice:empty`), 두 번째 규칙, 중복 선언 같은 관용적 CSS에
// 조용히 우회되어 실제 회귀를 green으로 통과시켰습니다.
//
// 셀렉터 판정은 접미(`^`) 앵커 없이 서브스트링/정규 매치로만 합니다. `.app-header
// .action-notice:empty`처럼 감싸진 형태도 같은 강도로 검사하기 위해서입니다.
// 중첩 표기는 `&`를 부모의 해석된 셀렉터로 치환해 펼칩니다(`&:empty` →
// `.action-notice:empty`, 그룹 부모는 곱집합, `&` 없는 중첩은 묵시적 후손 결합).
// 유효값은 `!important` 선언이 하나라도 있으면 그중 마지막, 없으면 마지막 선언입니다
// (캐스케이드와 같은 순서). 규칙 바로 아래 중첩 at-rule 안의 선언도 그 규칙의 선언으로
// 모으되, 인쇄 전용(`@media print`) 안쪽 선언은 화면 계산값에 영향이 없어 제외합니다.
// 인쇄 면제는 콤마로 쪼갠 모든 미디어 쿼리가 인쇄 전용일 때만 적용합니다
// (`print`·`print and (…)` → 면제, `print, screen`·`not print` → 면제 아님).
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
  /** `&`까지 해석한 실대상 셀렉터 목록(`&:empty` → `.action-notice:empty`). 노드 대상 판정은 이 목록으로 합니다. */
  readonly resolvedSelectors: readonly string[];
  /** 속성 → 유효값(`!important` 우선, 같으면 마지막 선언). */
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

/**
 * 괄호 깊이 0에서만 자르는 분할기. `min(210px, 100%)`의 콤마를 트랙 구분자로 오해하지 않습니다.
 * (트랙 목록의 구분자는 콤마가 아니라 공백입니다.) `grid-template` 단축의 `/`에도 씁니다.
 */
const splitTopLevel = (value: string, separator: "," | " " | "/"): readonly string[] => {
  const isSeparator = (character: string): boolean => {
    if (separator === ",") {
      return character === ",";
    }
    if (separator === "/") {
      return character === "/";
    }
    return /\s/.test(character);
  };

  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (const character of value) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth = Math.max(0, depth - 1);
    }

    if (depth === 0 && isSeparator(character)) {
      parts.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  parts.push(current);
  return parts.map((part) => normalizeText(part)).filter((part) => part.length > 0);
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

/**
 * 가장 가까운 규칙 조상을 찾습니다. 중간 at-rule은 건너뜁니다
 * (`action-notice { @media screen { &:empty { … } } }`도 `.action-notice`를 부모로 봐야 합니다).
 */
const parentRuleOf = (rule: Rule): Rule | undefined => {
  let current: ParentNode = rule.parent;
  while (current !== undefined) {
    const found = asRule(current);
    if (found !== undefined) {
      return found;
    }
    current = current.parent;
  }
  return undefined;
};

const selectorsOf = (rule: Rule): readonly string[] => {
  const raw = rule.selectors.map(normalizeText).filter((selector) => selector.length > 0);
  const parentRule = parentRuleOf(rule);

  // `.card { & { min-inline-size: 0 } }`처럼 순수 별칭으로만 중첩한 형태는 부모 대상을 그대로 물려받습니다.
  if (raw.length === 1 && raw[0] === "&" && parentRule !== undefined) {
    return selectorsOf(parentRule);
  }

  return raw.map(stripNesting).filter((selector) => selector.length > 0);
};

/** 자식 원문 셀렉터 하나를 부모의 해석된 셀렉터에 얹습니다(그룹 부모는 곱집합). */
const resolveSelectorText = (raw: string, parents: readonly string[]): readonly string[] => {
  if (parents.length === 0) {
    // 최상위 규칙: 원문이 그대로 대상입니다(`&`는 최상위에서 해석할 부모가 없습니다).
    return [normalizeText(raw.replace(/&/g, " "))].filter((text) => text.length > 0);
  }

  if (raw.includes("&")) {
    // `&:empty` → `.action-notice:empty`. `&-foo`처럼 `&` 뒤에 식별자가 붙으면 텍스트가 이어붙습니다
    // (그 형태는 실제 CSS 중첩 문법에서 무효라 별도 의미를 정의하지 않습니다).
    return parents.map((parent) => normalizeText(raw.replace(/&/g, parent)));
  }

  // `&` 없는 중첩은 묵시적 후손 결합입니다(`.app-shell { .action-notice { … } }`).
  return parents.map((parent) => normalizeText(`${parent} ${raw}`));
};

const resolvedCache = new WeakMap<Rule, readonly string[]>();

/**
 * 규칙이 실제로 겨냥하는 셀렉터 목록(중첩 해석 포함).
 * 원문만 보는 검사는 `.action-notice { &:empty { display: none } }` 같은 자기 중첩에 통째로 우회됩니다.
 */
const resolvedSelectorsOf = (rule: Rule): readonly string[] => {
  const cached = resolvedCache.get(rule);
  if (cached !== undefined) {
    return cached;
  }

  const parentRule = parentRuleOf(rule);
  const parents = parentRule === undefined ? [] : resolvedSelectorsOf(parentRule);
  const resolved = new Set<string>();

  for (const raw of rule.selectors.map(normalizeText).filter((text) => text.length > 0)) {
    for (const text of resolveSelectorText(raw, parents)) {
      if (text.length > 0) {
        resolved.add(text);
      }
    }
  }

  const list: readonly string[] = [...resolved];
  resolvedCache.set(rule, list);
  return list;
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

/**
 * 콤마로 쪼갠 모든 미디어 쿼리가 인쇄 전용일 때만 true입니다.
 * `/\bprint\b/` 서브스트링 판정은 `@media print, screen`·`@media not print`까지 인쇄 전용으로
 * 오판해 화면 회귀를 숨겼습니다. 선행 `not `/`only `를 떼고 미디어 타입을 봅니다.
 */
const isPrintOnlyMediaParams = (params: string): boolean =>
  splitTopLevel(params, ",").every((query) => {
    const withoutModifier = normalizeText(query.replace(/^only\s+/i, ""));
    const negated = /^not\s+/i.test(withoutModifier);
    const mediaType = /^([a-z-]+)/i.exec(
      negated ? withoutModifier.replace(/^not\s+/i, "") : withoutModifier,
    )?.[1];
    return !negated && mediaType?.toLowerCase() === "print";
  });

/** `@media print` 안쪽인지 조상 at-rule 체인으로 판정합니다(인쇄에서 숨기는 건 정상). */
const isPrintScoped = (rule: RuleView): boolean =>
  rule.atRules.some(
    (atRule) =>
      /^@media\b/i.test(atRule) &&
      isPrintOnlyMediaParams(atRule.replace(/^@media\b/i, "")),
  );

/**
 * 규칙 자신의 선언만 모읍니다(중첩 자식 규칙은 별개 규칙이라 제외).
 * 규칙 바로 아래 중첩 at-rule 안쪽은 재귀합니다 — `.action-notice:empty { …; @media screen {
 * display: none } }`처럼 중첩 at-rule에 숨긴 선언이 수집에서 빠지면 회귀가 green으로 통과합니다.
 * 인쇄 전용 at-rule 안쪽 선언은 화면 계산값에 영향이 없어 제외합니다.
 */
const collectDeclarations = (
  container: Container,
  sink: Declaration[],
  printScoped = false,
): void => {
  for (const node of container.nodes ?? []) {
    if (node.type === "decl") {
      if (!printScoped) {
        sink.push(node);
      }
      continue;
    }

    if (node.type === "atrule") {
      const atRule = node as AtRule;
      collectDeclarations(
        atRule,
        sink,
        printScoped || (atRule.name.toLowerCase() === "media" && isPrintOnlyMediaParams(atRule.params)),
      );
    }
  }
};

/**
 * 속성 → 유효값. `!important` 선언이 하나라도 있으면 그중 마지막, 없으면 마지막 선언입니다.
 * (`overflow-wrap: break-word !important; overflow-wrap: anywhere;`의 계산값은 break-word인데
 * 마지막 선언만 보면 anywhere로 통과합니다.)
 */
const effectiveDeclarations = (rule: Rule): ReadonlyMap<string, DeclaredValue> => {
  const ordered = new Map<string, DeclaredValue[]>();
  const collected: Declaration[] = [];
  collectDeclarations(rule, collected);

  for (const node of collected) {
    const key = propertyKey(node.prop);
    const list = ordered.get(key) ?? [];
    list.push({ value: node.value.trim(), important: node.important });
    ordered.set(key, list);
  }

  const effective = new Map<string, DeclaredValue>();
  for (const [key, list] of ordered) {
    const importants = list.filter((declared) => declared.important);
    const winner = (importants.length > 0 ? importants[importants.length - 1] : list[list.length - 1]);
    if (winner !== undefined) {
      effective.set(key, winner);
    }
  }

  return effective;
};

const toRuleView = (rule: Rule): RuleView => {
  const { atRules, parentRules } = ancestorsOf(rule);

  return {
    selector: normalizeText(rule.selector),
    selectors: selectorsOf(rule),
    resolvedSelectors: resolvedSelectorsOf(rule),
    decls: effectiveDeclarations(rule),
    atRules,
    parentRules,
  };
};

/** 중첩 규칙도 AST에 그대로 나오므로 walkRules 한 번이면 깊이와 무관하게 전부 수집됩니다. */
const rules: RuleView[] = [];
root.walkRules((rule) => {
  rules.push(toRuleView(rule));
});

/** 실패 메시지용 라벨: 해석 결과가 원문과 다르면 함께 보여줍니다. */
const ruleLabel = (rule: RuleView): string =>
  rule.resolvedSelectors.some((selector) => selector !== rule.selector)
    ? `${rule.selector} → ${rule.resolvedSelectors.join(", ")}`
    : rule.selector;

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

/**
 * 빈 상태(`:empty`)를 겨냥하는 셀렉터인지. `:not(:empty)`은 직접 인자가 빈 상태 술어라
 * "채워진 상태"입니다 — 빈 상태로 분류하면 숨김 재료 누출 검사를 그대로 우회합니다.
 */
const isEmptyStateSelector = (selector: string): boolean => {
  const emptyPseudo = /:empty(?![\w-])/gi;
  let match = emptyPseudo.exec(selector);

  while (match !== null) {
    if (!/:not\(\s*$/i.test(selector.slice(0, match.index))) {
      return true;
    }
    match = emptyPseudo.exec(selector);
  }

  return false;
};

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
 * 대소문자는 구분하지 않습니다(`MINMAX(320px, 1fr)` 우회 방지).
 */
const minmaxFirstArguments = (value: string, owner: string): readonly MinmaxUsage[] => {
  const usages: MinmaxUsage[] = [];
  const needle = "minmax(";

  for (let index = 0; index < value.length; index += 1) {
    if (value.slice(index, index + needle.length).toLowerCase() !== needle) {
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

/** 괄호 밖 타입 토큰: 숫자 + 단위(예: `320px`·`20rem`·`50vw`). `50%`는 컨테이너 기준이라 제외됩니다. */
const LENGTH_WITH_UNIT = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)([a-z]+)$/i;
/** 트랙 이름표(`[full-start]`)는 크기가 아니라 이름이라 토큰에서 떼어냅니다. */
const LINE_NAME = /\[[^\]]*\]/g;

const stripLineNames = (token: string): string => normalizeText(token.replace(LINE_NAME, " "));

/** 컨테이너 폭과 무관하게 고정되는 맨 절대 길이 트랙인지(`0`·`0px`은 허용, `1fr`은 유연). */
const isFixedAbsoluteTrack = (token: string): boolean => {
  const match = LENGTH_WITH_UNIT.exec(normalizeText(token));
  if (match === null) {
    return false;
  }

  if ((match[1] ?? "").toLowerCase() === "fr") {
    return false;
  }

  return Number.parseFloat(match[0]) !== 0;
};

type FixedTrack = {
  /** 실패 메시지용 위치 설명(규칙 셀렉터 · 속성). */
  readonly owner: string;
  readonly track: string;
};

/**
 * 트랙 목록에서 맨 고정 길이 트랙을 찾습니다. 트랙 구분자는 콤마가 아니라 **공백**이라
 * 괄호 깊이 0의 공백에서 토큰화합니다. `repeat(A, 트랙목록)`은 첫 콤마 뒤를 재귀 검사합니다
 * (`repeat(2, 320px)`·`repeat(auto-fit, 320px 1fr)` 포함).
 * minmax()의 첫 인자 검사는 위에서 따로 유지합니다(래핑을 통째로 뺀 형태가 여기서 걸립니다).
 */
const fixedTracksIn = (value: string, owner: string): readonly FixedTrack[] => {
  const found: FixedTrack[] = [];

  for (const rawToken of splitTopLevel(value, " ")) {
    const token = stripLineNames(rawToken);
    if (token.length === 0) {
      continue;
    }

    const repeat = /^repeat\(([\s\S]*)\)$/i.exec(token);
    if (repeat !== null) {
      const repeatArguments = splitTopLevel(repeat[1] ?? "", ",");
      // 첫 인자는 반복 횟수(2)나 auto-fit/auto-fill 키워드라 트랙이 아닙니다.
      found.push(...fixedTracksIn(repeatArguments.slice(1).join(", "), owner));
      continue;
    }

    if (isFixedAbsoluteTrack(token)) {
      found.push({ owner, track: rawToken });
    }
  }

  return found;
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

    // 유효값은 `!important` 우선·같으면 마지막 선언 기준입니다.
    // `overflow-wrap: anywhere; overflow-wrap: break-word;`처럼 중복 선언으로 되돌리거나
    // `break-word !important`로 덮으면 계산값이 break-word가 되어 좁은 화면이 다시 밀려납니다.
    for (const rule of wrappingRules) {
      expect(
        declaredValue(rule, "overflow-wrap"),
        `${ruleLabel(rule)}의 overflow-wrap 유효값(!important 우선, 같으면 마지막 선언)이 anywhere가 아닙니다`,
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

  it("그리드 트랙을 맨 고정 길이로 고정하지 않는다", () => {
    // minmax()의 첫 인자만 보던 검사는 래핑을 통째로 뺀 형태를 놓쳤습니다:
    // `.app-footer { grid-template-columns: 320px 1fr }`는 계약 6/6 green인데
    // 실브라우저(360px)에서 354 > 345(+9px), `.metric-grid`는 391 > 345(+46px)로 밀렸습니다.
    const fixed: FixedTrack[] = [];
    let scanned = 0;

    root.walkDecls((declaration) => {
      const owner = `${ownerOf(declaration)} · ${declaration.prop}`;
      const key = propertyKey(declaration.prop);

      if (key === "grid-template-columns") {
        fixed.push(...fixedTracksIn(declaration.value, owner));
        scanned += 1;
        return;
      }

      // `grid-template` 단축은 슬래시 뒤가 열 트랙입니다(앞은 행 트랙이라 가로 오버플로와 무관).
      if (key === "grid-template") {
        const parts = splitTopLevel(declaration.value, "/");
        if (parts.length > 1) {
          fixed.push(...fixedTracksIn(parts.slice(1).join(" / "), owner));
          scanned += 1;
        }
      }
    });

    expect(scanned, "grid-template-columns 선언을 찾지 못했습니다").toBeGreaterThan(0);
    expect(
      fixed.map((entry) => `${entry.owner}: ${entry.track}`),
      "맨 고정 트랙은 좁은 화면에서 줄어들지 않아 가로 오버플로를 만듭니다(minmax(min(…,100%),1fr) 같은 래핑을 쓰세요)",
    ).toEqual([]);
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
      .map((rule) => `${ruleLabel(rule)} { all: ${declaredValue(rule, "all") ?? ""} }`);

    expect(offenders, "줄바꿈 대상 요소의 캐스케이드가 되돌려집니다").toEqual([]);
  });
});

describe("index.css 빈 라이브 리전 처리", () => {
  it("빈 .action-notice를 display가 아니라 시각적 숨김으로 처리해 AX 트리에 남긴다", () => {
    // 대상 판정은 `&`까지 해석한 셀렉터 목록으로 합니다. 원문만 보면
    // `.action-notice { &:empty { display: none } }`처럼 자기 중첩으로 쓴 규칙이 통째로
    // 사정권 밖이 됩니다(실측: 계약 green인데 AX role=status 노드가 1→0으로 사라짐).
    const noticeRules = rules.filter((rule) =>
      rule.resolvedSelectors.some((selector) => selector.includes(NOTICE_SELECTOR)),
    );

    expect(noticeRules.length, ".action-notice 규칙을 찾지 못했습니다").toBeGreaterThan(0);

    const screenRules = noticeRules.filter((rule) => !isPrintScoped(rule));
    const emptyRules = screenRules.filter((rule) =>
      rule.resolvedSelectors.some(isEmptyStateSelector),
    );
    // `:not(:empty)`은 "채워진 상태"라 숨김 재료가 새면 안 되는 쪽으로 보냅니다.
    const baseRules = screenRules.filter((rule) =>
      rule.resolvedSelectors.some((selector) => !isEmptyStateSelector(selector)),
    );

    // 빈 상태 계약과 기본 계약이 화면용으로 각각 존재해야 합니다.
    // (인쇄에서만 선언해 두면 화면에서는 계약이 사라집니다.)
    expect(emptyRules.length, "화면용 .action-notice:empty 규칙을 찾지 못했습니다").toBeGreaterThan(
      0,
    );
    expect(baseRules.length, "화면용 기본 .action-notice 규칙을 찾지 못했습니다").toBeGreaterThan(0);

    // (1) .action-notice를 겨냥하는 모든 규칙에서 노드 제거 금지(인쇄 매체 예외).
    // display: none·visibility: hidden은 노드를 접근성 트리에서 통째로 빼버립니다.
    for (const rule of screenRules) {
      expect(
        nodeRemovers(rule),
        `${ruleLabel(rule)}에 노드 제거 선언 금지(AX 트리에서 사라집니다)`,
      ).toEqual([]);
    }

    // (2) `:empty` 규칙은 시각적 숨김 레시피를 유효값으로 갖춰야 합니다.
    for (const rule of emptyRules) {
      expect(
        unmetSteps(rule, HIDDEN_RECIPE),
        `${ruleLabel(rule)}에 시각적 숨김 레시피가 빠졌습니다`,
      ).toEqual([]);
    }

    // (3) 채워진 규칙(`:empty` 아님)에는 숨김 레시피가 새면 안 됩니다.
    // 두 번째 규칙으로 clip-path를 덧씌워 안내를 가리는 회귀를 막습니다.
    // (기본 규칙의 정확한 display 값은 고정하지 않습니다: flex·grid 같은 동등 표현은 정당합니다.)
    for (const rule of baseRules) {
      expect(
        leakedSteps(rule, RECIPE_PRIMITIVES),
        `${ruleLabel(rule)}에 시각적 숨김 레시피가 새어 들어갔습니다`,
      ).toEqual([]);
    }
  });
});

// 아래는 위 검사기 자체를 합성 CSS fixture로 검증합니다. 파서·판정 헬퍼가 조용히
// 무력해지면(예: 중첩 셀렉터 해석 실패) 실제 계약은 다시 우회되므로, 우회 구멍을
// 자기 테스트로 고정합니다.
describe("검사기 자기 검증 — 합성 CSS fixture", () => {
  const rulesOf = (source: string): readonly Rule[] => {
    const fixtureRoot = parse(source);
    const found: Rule[] = [];
    fixtureRoot.walkRules((rule) => {
      found.push(rule);
    });
    return found;
  };

  const lastRuleOf = (source: string): Rule => {
    const found = rulesOf(source);
    const last = found[found.length - 1];
    if (last === undefined) {
      throw new Error("fixture에 규칙이 없습니다");
    }
    return last;
  };

  const resolvedFor = (source: string): readonly string[] => resolvedSelectorsOf(lastRuleOf(source));
  const viewFor = (source: string): RuleView => toRuleView(lastRuleOf(source));
  const declsFor = (source: string): ReadonlyMap<string, DeclaredValue> => viewFor(source).decls;

  describe("중첩 셀렉터 해석(&)", () => {
    it("중첩이 아닌 규칙은 prefix 텍스트를 그대로 남긴다", () => {
      expect(resolvedFor(".app-header .action-notice:empty { display: none }")).toEqual([
        ".app-header .action-notice:empty",
      ]);
    });

    it("부모 안의 `&`를 부모 셀렉터로 치환한다", () => {
      const resolved = resolvedFor(".action-notice { &:empty { display: none } }");

      expect(resolved).toContain(".action-notice:empty");
      expect(resolved.some((selector) => selector.startsWith("&"))).toBe(false);
    });

    it("`&` 없는 중첩은 묵시적 후손 결합으로 펼친다", () => {
      expect(resolvedFor(".app-shell { .action-notice:empty { display: none } }")).toContain(
        ".app-shell .action-notice:empty",
      );
    });

    it("중첩 체인과 중간 at-rule을 건너뛰고 부모를 찾는다", () => {
      expect(
        resolvedFor(".app-shell { .action-notice { &:empty { display: none } } }"),
      ).toContain(".app-shell .action-notice:empty");
      expect(
        resolvedFor(".action-notice { @media screen { &:empty { display: none } } }"),
      ).toContain(".action-notice:empty");
    });

    it("순수 `&` 별칭은 부모 대상을 물려받는다", () => {
      expect(resolvedFor(".card { & { min-inline-size: 0 } }")).toEqual([".card"]);
    });

    it("`&-foo`는 부모 텍스트에 이어붙는다(무효 문법이지만 조용히 사라지지 않는다)", () => {
      expect(resolvedFor(".notice { &.is-hidden { display: none } }")).toEqual([
        ".notice.is-hidden",
      ]);
      expect(resolvedFor(".notice { &-decoy { display: none } }")).toEqual([".notice-decoy"]);
    });

    it("그룹 부모는 곱집합으로 펼친다", () => {
      const resolved = resolvedFor(".action-notice, .harness-other { &:empty { display: none } }");

      expect(resolved).toContain(".action-notice:empty");
      expect(resolved).toContain(".harness-other:empty");
    });

    it("`:not(:empty)`은 채워진 상태로, `:empty`는 빈 상태로 본다", () => {
      expect(isEmptyStateSelector(".action-notice:empty")).toBe(true);
      expect(isEmptyStateSelector(".app-shell .action-notice:empty > span")).toBe(true);
      expect(isEmptyStateSelector(".action-notice:not(:empty)")).toBe(false);
      expect(isEmptyStateSelector(".action-notice")).toBe(false);
      expect(isEmptyStateSelector(".action-notice:empty, .other:not(:empty)")).toBe(true);
      expect(resolvedFor(".action-notice { &:not(:empty) { clip-path: inset(50%) } }").some(isEmptyStateSelector)).toBe(false);
    });
  });

  describe("선언 수집과 유효값", () => {
    it("규칙 바로 아래 중첩 at-rule 안의 선언도 그 규칙의 선언으로 모은다", () => {
      expect(
        declsFor(".action-notice:empty { display: flex; @media screen { display: none } }").get(
          "display",
        )?.value,
      ).toBe("none");
    });

    it("인쇄 전용 nested at-rule의 선언은 화면 계산값에서 제외한다", () => {
      expect(
        declsFor(".action-notice:empty { display: flex; @media print { display: none } }").get(
          "display",
        )?.value,
      ).toBe("flex");
    });

    it("중첩 자식 규칙의 선언은 부모 규칙에 섞이지 않는다", () => {
      const found = rulesOf(".card { color: red; .child { color: blue } }");
      const parent = found[0];
      const child = found[1];

      expect(parent === undefined ? undefined : toRuleView(parent).decls.get("color")?.value).toBe(
        "red",
      );
      expect(child === undefined ? undefined : toRuleView(child).decls.get("color")?.value).toBe(
        "blue",
      );
    });

    it("유효값은 !important 선언이 있으면 그중 마지막, 없으면 마지막 선언이다", () => {
      expect(
        declsFor(".x { overflow-wrap: break-word !important; overflow-wrap: anywhere }").get(
          "overflow-wrap",
        )?.value,
      ).toBe("break-word");
      expect(
        declsFor(".x { overflow-wrap: anywhere !important; overflow-wrap: break-word }").get(
          "overflow-wrap",
        )?.value,
      ).toBe("anywhere");
      expect(
        declsFor(".x { overflow-wrap: anywhere; overflow-wrap: break-word }").get("overflow-wrap")
          ?.value,
      ).toBe("break-word");
      expect(
        declsFor(
          ".x { overflow-wrap: break-word !important; overflow-wrap: anywhere !important }",
        ).get("overflow-wrap")?.value,
      ).toBe("anywhere");
    });

    it("word-wrap은 overflow-wrap 별칭으로 합쳐진다", () => {
      expect(declsFor(".x { word-wrap: break-word }").get("overflow-wrap")?.value).toBe(
        "break-word",
      );
    });
  });

  describe("인쇄 면제와 트랙 판정", () => {
    it("인쇄 면제는 콤마로 쪼갠 모든 쿼리가 인쇄 전용일 때만 적용한다", () => {
      const exempt = (media: string): boolean =>
        isPrintScoped(viewFor(`${media} { .action-notice:empty { display: none } }`));

      expect(exempt("@media print")).toBe(true);
      expect(exempt("@media print and (max-width: 420px)")).toBe(true);
      expect(exempt("@media only print")).toBe(true);
      expect(exempt("@media print, screen")).toBe(false);
      expect(exempt("@media screen, print")).toBe(false);
      expect(exempt("@media not print")).toBe(false);
      expect(exempt("@media screen")).toBe(false);
      expect(exempt("@media (max-width: 420px)")).toBe(false);
    });

    it("minmax 스캐너는 대소문자를 구분하지 않는다", () => {
      const usages = minmaxFirstArguments("MINMAX(320px, 1fr)", "fixture");

      expect(usages.map((usage) => usage.firstArgument)).toEqual(["320px"]);
      expect(isShrinkableMinimum(usages[0]?.firstArgument ?? "")).toBe(false);
      expect(minmaxFirstArguments("minmax(min(210px, 100%), 1fr)", "fixture")[0]?.firstArgument).toBe(
        "min(210px, 100%)",
      );
    });

    it("고정 트랙 스캐너는 맨 절대 길이만 잡는다", () => {
      const tracks = (value: string): readonly string[] =>
        fixedTracksIn(value, "fixture").map((entry) => entry.track);

      expect(tracks("320px 1fr")).toEqual(["320px"]);
      // 콤마는 트랙 구분자가 아니라서(무효 문법) `50vw,`는 길이 토큰으로 인식되지 않지만,
      // 뒤따르는 순수 길이는 그대로 잡힙니다 — 무효 문법이 검사를 흐리지 않습니다.
      expect(tracks("50vw, 20rem")).toEqual(["20rem"]);
      expect(tracks("50vw 20rem")).toEqual(["50vw", "20rem"]);
      expect(tracks("repeat(auto-fit, 320px)")).toEqual(["320px"]);
      expect(tracks("repeat(2, 320px 1fr)")).toEqual(["320px"]);
      expect(tracks("repeat(2, minmax(min(260px, 100%), 1fr))")).toEqual([]);
      expect(tracks("[full-start] 320px [full-end]")).toEqual(["320px"]);
      expect(tracks("[a]320px[b]")).toEqual(["[a]320px[b]"]);
      expect(tracks("0px 0 1fr auto min-content max-content subgrid")).toEqual([]);
      expect(
        tracks("fit-content(320px) calc(100% - 2rem) clamp(1px, 2vw, 3px) var(--tracks, 1fr)"),
      ).toEqual([]);
    });
  });
});
