import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import App from "./App";

describe("TrustGate dashboard", () => {
  it("shows the four-stage evidence flow", () => {
    render(<App />);
    expect(screen.getByText("변경 파일")).toBeInTheDocument();
    expect(screen.getByText("취약점 가설")).toBeInTheDocument();
    expect(screen.getByText("격리 재현")).toBeInTheDocument();
    expect(screen.getByText("패치 회귀 검증")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "샘플 분석 실행" })).toBeEnabled();
  });
});

describe("샘플 실행 안내 라이브 리전", () => {
  it("렌더 직후에도 빈 상태의 status 리전이 머리말 안에 존재한다", () => {
    render(<App />);

    const region = screen.getByRole("status");

    // 노드가 클릭 시점에 삽입되면 보조기술이 낭독을 놓치므로, 항상 존재해야 합니다.
    expect(region).toBeEmptyDOMElement();
    expect(region.closest("header")).not.toBeNull();
  });

  it("버튼을 눌러도 같은 리전 노드가 유지된 채 안내 문구가 채워진다", () => {
    render(<App />);
    const region = screen.getByRole("status");

    fireEvent.click(screen.getByRole("button", { name: "샘플 분석 실행" }));

    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("정적 샘플 화면입니다");
    expect(region.closest("header")).not.toBeNull();
  });
});
