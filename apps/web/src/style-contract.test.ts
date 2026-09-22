// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// jsdom에는 레이아웃 엔진이 없어 실제 렌더 폭·스크롤 폭을 측정할 수 없습니다.
// 그래서 이 파일은 360px 가로 오버플로 회귀를 "소스 불변식"으로 고정합니다.
// 실제 기하 검증은 CDP 실브라우저 프로브가 담당하고, 여기서는 CSS가 다시
// 헐거워지지 않도록 규칙 블록 단위로만 확인합니다(전체 파일 동일성 비교 금지).
//
// `?raw` import는 이 Vitest 설정에서 빈 문자열로 스텁되므로 파일을 직접 읽습니다.
const cssSource = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8");

type CssRule = {
  readonly selectors: readonly string[];
  readonly body: string;
};

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 중괄호가 중첩되지 않은 단순 규칙만 뽑습니다. @media 내부 규칙도 함께 수집됩니다. */
function parseRules(css: string): readonly CssRule[] {
  const rules: CssRule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;

  for (const match of stripComments(css).matchAll(pattern)) {
    const declared = match[1] ?? "";
    const body = match[2] ?? "";
    const selectors = declared
      .split(",")
      .map((selector) => selector.trim().replace(/\s+/g, " "))
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

  it("줄바꿈 규칙 그룹이 span·button을 포함해 긴 토큰을 감싼다", () => {
    const wrapped = selectorsOf((rule) => /overflow-wrap\s*:/.test(rule.body));

    // 기존 대상이 빠지지 않았는지 먼저 고정합니다.
    for (const selector of ["h1", "h2", "h3", "p", "li", "pre", "code"]) {
      expect(wrapped).toContain(selector);
    }

    // span(.action-meta, .status)과 button(.action)이 빠져 360px에서 밀려난 회귀를 막습니다.
    expect(wrapped).toContain("span");
    expect(wrapped).toContain("button");
  });

  it(".app-header와 .app-footer가 그리드 자식으로서 줄어들 수 있다", () => {
    for (const selector of [".app-header", ".app-footer"]) {
      const rule = rules.find((candidate) => candidate.selectors.includes(selector));

      expect(rule, `${selector} 규칙을 찾지 못했습니다`).toBeDefined();
      expect(rule?.body, `${selector}에 min-inline-size: 0이 없습니다`).toMatch(
        /min-inline-size\s*:\s*0\b/,
      );
    }
  });

  it("미사용 .evidence-grid 선택자가 제거되고 .metric-grid 스타일은 남아 있다", () => {
    const allSelectors = rules.flatMap((rule) => rule.selectors);

    expect(allSelectors).not.toContain(".evidence-grid");

    // 그룹 셀렉터에서 한쪽만 지우다 .metric-grid까지 잃는 실수를 막습니다.
    const metricGrid = rules.find((rule) => rule.selectors.includes(".metric-grid"));

    expect(metricGrid, ".metric-grid 규칙을 찾지 못했습니다").toBeDefined();
    expect(metricGrid?.body).toMatch(/grid-template-columns\s*:/);
  });
});

describe("index.css 빈 라이브 리전 처리", () => {
  it("빈 .action-notice가 시각적으로 0 높이가 되도록 display: none을 갖는다", () => {
    const isActionNotice = (selector: string): boolean =>
      selector.startsWith(".action-notice");

    const emptyStateRule = rules.find(
      (candidate) =>
        candidate.selectors.some((selector) => /^\.action-notice\s*:empty\b/.test(selector)) &&
        /display\s*:\s*none/.test(candidate.body),
    );

    expect(emptyStateRule, "빈 상태 .action-notice 숨김 규칙을 찾지 못했습니다").toBeDefined();

    // 문구가 채워진 상태까지 숨기면 안내가 영영 보이지 않습니다.
    const populatedRule = rules.find(
      (candidate) =>
        candidate.selectors.includes(".action-notice") &&
        candidate.body.includes("display"),
    );

    expect(populatedRule, "기본 .action-notice 규칙을 찾지 못했습니다").toBeDefined();
    expect(populatedRule?.body).not.toMatch(/display\s*:\s*none/);
    expect(
      rules.some(
        (candidate) =>
          candidate.selectors.some(isActionNotice) &&
          /display\s*:\s*flex/.test(candidate.body),
      ),
    ).toBe(true);
  });
});
