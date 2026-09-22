// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// jsdom에는 레이아웃 엔진이 없어 실제 렌더 폭·스크롤 폭을 측정할 수 없습니다.
// 그래서 이 파일은 360px 가로 오버플로 회귀를 "소스 불변식"으로 고정합니다.
// 실제 기하 검증은 CDP 실브라우저 프로브가 담당하고, 여기서는 CSS가 다시
// 헐거워지지 않도록 규칙 블록 단위로만 확인합니다(전체 파일 동일성 비교 금지).
// 값은 존재 여부만 보지 않고 고정합니다. 속성 이름만 검사하면
// overflow-wrap: break-word, minmax(320px, 1fr)처럼 되돌려도 통과해 버립니다.
//
// `?raw` import는 이 Vitest 설정에서 빈 문자열로 스텁되므로 파일을 직접 읽습니다.
const cssSource = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8");

type CssRule = {
  readonly selectors: readonly string[];
  readonly body: string;
};

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 중괄호가 중첩되지 않은 단순 규칙만 뽑습니다. @media 내부 규칙도 함께 수집됩니다.
 * CSS Nesting은 중첩 블록 자체를 파싱하지 않고 선행 `&` 정규화로만 지원합니다
 * (예: `& span` → `span`). 브라우저에서 도는 실제 검증은 CDP 프로브가 담당합니다.
 */
function parseRules(css: string): readonly CssRule[] {
  const rules: CssRule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;

  for (const match of stripComments(css).matchAll(pattern)) {
    const declared = match[1] ?? "";
    const body = match[2] ?? "";
    const selectors = declared
      .split(",")
      .map((selector) =>
        selector
          .trim()
          .replace(/\s+/g, " ")
          // Nesting 재작성(`& span`)을 플랫 셀렉터(`span`)로 정규화합니다.
          .replace(/^&+\s*/, ""),
      )
      .filter((selector) => selector.length > 0);

    if (selectors.length > 0) {
      rules.push({ selectors, body });
    }
  }

  return rules;
}

const rules = parseRules(cssSource);

const selectorsOf = (predicate: (rule: CssRule) => boolean): readonly string[] =>
  rules.filter(predicate).flatMap((rule) => rule.selectors);

describe("index.css 좁은 화면 계약", () => {
  it("CSS 소스를 실제로 읽었다", () => {
    // 파서가 빈 소스를 상대로 통과하는 가짜 GREEN을 막습니다.
    expect(cssSource.length).toBeGreaterThan(1000);
    expect(rules.length).toBeGreaterThan(20);
  });

  it("줄바꿈 규칙 그룹이 span·button을 포함하고 값을 anywhere로 고정한다", () => {
    const wrappingRules = rules.filter((rule) => /overflow-wrap\s*:/.test(rule.body));

    expect(wrappingRules.length, "overflow-wrap 규칙을 찾지 못했습니다").toBeGreaterThan(0);

    // 존재만 보면 값이 normal·break-word로 돌아가도 통과합니다.
    // anywhere → break-word 치환은 360px에서 문서 폭을 다시 2624px까지 밀어냅니다.
    for (const rule of wrappingRules) {
      expect(rule.body, `${rule.selectors.join(", ")}의 overflow-wrap 값`).toMatch(
        /overflow-wrap\s*:\s*anywhere\b/,
      );
    }

    const wrapped = wrappingRules.flatMap((rule) => rule.selectors);

    // 기존 대상이 빠지지 않았는지 먼저 고정합니다.
    for (const selector of ["h1", "h2", "h3", "p", "li", "pre", "code"]) {
      expect(wrapped).toContain(selector);
    }

    // span(.action-meta, .status)과 button(.action)이 빠져 360px에서 밀려난 회귀를 막습니다.
    // 전역 span·button 리터럴 적용이라 클래스 스코프로 축소하면 다시 밀려납니다.
    expect(wrapped).toContain("span");
    expect(wrapped).toContain("button");
  });

  it("그리드 자식이 줄어들도록 min-inline-size: 0이 선언되어 있다", () => {
    // .app-header/.app-footer만 보던 검사를 카드 표면(.surface·.card 공유 규칙)과
    // .footer-block까지 넓혔습니다. 그룹 셀렉터는 각 셀렉터를 개별로 확인합니다.
    for (const selector of [".app-header", ".app-footer", ".surface", ".card", ".footer-block"]) {
      const declared = rules.filter(
        (rule) => rule.selectors.includes(selector) && /min-inline-size\s*:/.test(rule.body),
      );

      expect(declared.length, `${selector}에 min-inline-size 선언이 없습니다`).toBeGreaterThan(0);

      for (const rule of declared) {
        expect(rule.body, `${selector}의 min-inline-size 값`).toMatch(/min-inline-size\s*:\s*0\b/);
      }
    }
  });

  it("미사용 .evidence-grid 선택자가 제거되고 그리드 트랙이 minmax(min(...))로 고정되어 있다", () => {
    const allSelectors = rules.flatMap((rule) => rule.selectors);

    expect(allSelectors).not.toContain(".evidence-grid");

    // 그룹 셀렉터에서 한쪽만 지우다 .metric-grid까지 잃는 실수를 막습니다.
    const metricGrid = rules.find((rule) => rule.selectors.includes(".metric-grid"));

    expect(metricGrid, ".metric-grid 규칙을 찾지 못했습니다").toBeDefined();
    expect(metricGrid?.body).toMatch(/grid-template-columns\s*:/);

    // 트랙도 존재만 보지 않고 값을 고정합니다. min() 래핑이 빠지면
    // minmax(320px, 1fr) 같은 고정 최소 트랙이 320px 화면을 3348px까지 밀어냅니다.
    // 대상은 파일 전체입니다: grid-template-columns를 쓰는 규칙은 하나도 빠짐없이
    // minmax(min(...))여야 하고, 미래에 추가되는 그리드 규칙도 같은 강도를 받습니다.
    const trackRules = rules.filter((rule) => /grid-template-columns\s*:/.test(rule.body));

    expect(trackRules.length, "그리드 트랙 규칙을 찾지 못했습니다").toBeGreaterThan(0);

    for (const rule of trackRules) {
      expect(rule.body, `${rule.selectors.join(", ")}의 트랙 최소값`).toMatch(/minmax\(\s*min\(/);
    }

    // 그룹 셀렉터에서 한쪽만 지우는 실수를 막기 위해 기대 셀렉터도 개별로 고정합니다.
    const trackSelectors = trackRules.flatMap((rule) => rule.selectors);

    for (const selector of [".metric-grid", ".flow", ".evidence", ".app-footer"]) {
      expect(trackSelectors, `${selector}의 그리드 트랙 규칙을 찾지 못했습니다`).toContain(selector);
    }
  });
});

describe("index.css 빈 라이브 리전 처리", () => {
  it("빈 .action-notice를 display가 아니라 시각적 숨김으로 처리해 AX 트리에 남긴다", () => {
    const emptyRules = rules.filter((rule) =>
      rule.selectors.some((selector) => /^\.action-notice:empty\b/.test(selector)),
    );

    expect(emptyRules.length, "빈 상태 .action-notice 규칙을 찾지 못했습니다").toBeGreaterThan(0);

    for (const rule of emptyRules) {
      const where = rule.selectors.join(", ");

      // display: none·visibility: hidden은 노드를 접근성 트리에서 통째로 제거합니다.
      // CDP 실측: 빈 상태에서 display:none이면 role=status가 ignored(notRendered)로 사라집니다.
      expect(rule.body, `${where}에 display: none 금지`).not.toMatch(/display\s*:\s*none/);
      expect(rule.body, `${where}에 visibility: hidden 금지`).not.toMatch(
        /visibility\s*:\s*hidden/,
      );

      // 렌더는 유지하면서 화면에서만 1px로 줄이는 시각적 숨김 레시피를 요구합니다.
      expect(rule.body, `${where}에 position: absolute가 없습니다`).toMatch(
        /position\s*:\s*absolute\b/,
      );
      expect(rule.body, `${where}에 inline-size: 1px가 없습니다`).toMatch(
        /inline-size\s*:\s*1px\b/,
      );
      expect(rule.body, `${where}에 block-size: 1px가 없습니다`).toMatch(/block-size\s*:\s*1px\b/);
      expect(rule.body, `${where}에 padding: 0이 없습니다`).toMatch(/padding\s*:\s*0\b/);
      expect(rule.body, `${where}에 border: 0이 없습니다`).toMatch(/border\s*:\s*0\b/);
      expect(rule.body, `${where}에 overflow: hidden이 없습니다`).toMatch(
        /overflow\s*:\s*hidden\b/,
      );
      expect(rule.body, `${where}에 clip-path: inset(50%)가 없습니다`).toMatch(
        /clip-path\s*:\s*inset\(\s*50%\s*\)/,
      );
    }

    // 문구가 채워진 상태까지 숨기면 안내가 영영 보이지 않습니다.
    const populatedRule = rules.find((rule) => rule.selectors.includes(".action-notice"));

    expect(populatedRule, "기본 .action-notice 규칙을 찾지 못했습니다").toBeDefined();
    expect(populatedRule?.body, "채워진 상태는 flex로 보여야 합니다").toMatch(
      /display\s*:\s*flex\b/,
    );
    expect(populatedRule?.body, "기본 규칙에 시각적 숨김 레시피가 새면 안 됩니다").not.toMatch(
      /clip-path/,
    );
  });
});
