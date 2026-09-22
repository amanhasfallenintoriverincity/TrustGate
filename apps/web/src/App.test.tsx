import { render, screen } from "@testing-library/react";
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
