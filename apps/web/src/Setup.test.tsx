import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import Setup from "./Setup";
import { getSetup, isEnvName, saveCredential, saveSetup, startCodexLogin, getCodexLoginStatus, startWorkspaceRun, testSetup } from "./lib/setup";
import type { SetupSettings, SetupStatus } from "./lib/setup";

vi.mock("./lib/setup", async (importOriginal) => ({
  isEnvName: (await importOriginal<typeof import("./lib/setup")>()).isEnvName,
  isLoopbackBaseUrl: (await importOriginal<typeof import("./lib/setup")>()).isLoopbackBaseUrl,
  isSafeSetupFields: (await importOriginal<typeof import("./lib/setup")>()).isSafeSetupFields,
  getSetup: vi.fn(),
  saveSetup: vi.fn(),
  saveCredential: vi.fn(),
  cancelCodexLogin: vi.fn(),
  testSetup: vi.fn(),
  startCodexLogin: vi.fn(),
  getCodexLoginStatus: vi.fn(),
  startWorkspaceRun: vi.fn(),
}));

const emptyFixture: SetupStatus = { mode: "fixture", configured: false, settings: null };
const configured: SetupStatus = {
  mode: "workspace",
  configured: true,
  settings: {
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "my-model",
    apiKeyEnv: "",
    sandboxImage: "trustgate-sandbox:local",
    keyAvailable: false,
  },
};

beforeEach(() => {
  window.history.replaceState(null, "", "/#/setup");
  vi.mocked(getSetup).mockReset().mockResolvedValue(emptyFixture);
  vi.mocked(saveSetup).mockReset().mockResolvedValue(configured);
  vi.mocked(saveCredential).mockReset().mockResolvedValue(undefined);
  vi.mocked(testSetup).mockReset().mockResolvedValue(undefined);
  vi.mocked(startCodexLogin).mockReset().mockResolvedValue({ url: "https://auth.openai.com/oauth/authorize?state=example" });
  vi.mocked(getCodexLoginStatus).mockReset().mockResolvedValue({ state: "pending" });
  vi.mocked(startWorkspaceRun).mockReset();
});

describe("first-run inline setup", () => {
  it("loads the missing configuration inline, with a masked credential field and no dialog", async () => {
    render(<Setup onStatusChange={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "첫 실행 설정" })).toBeInTheDocument();
    expect(screen.getByLabelText("제공자 종류")).toHaveValue("openai-compatible");
    expect(screen.getByLabelText("기본 URL")).toBeInTheDocument();
    expect(screen.getByLabelText("모델")).toBeInTheDocument();
    expect(screen.getByLabelText("API 인증 정보")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "인증 정보 저장" })).toBeDisabled();
    expect(screen.getByLabelText("샌드박스 이미지")).toBeInTheDocument();
    expect(screen.queryByLabelText("인증 환경 변수 이름")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/샘플 모드는 별개/)).toBeInTheDocument();
  });

  it("saves only non-secret settings; connection test is a separate action", async () => {
    const onStatusChange = vi.fn();
    vi.mocked(saveSetup).mockImplementation(async (settings: SetupSettings) => ({
      mode: "workspace", configured: true,
      settings: { ...settings, keyAvailable: false },
    }));
    render(<Setup onStatusChange={onStatusChange} />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });
    fireEvent.change(screen.getByLabelText("제공자 종류"), { target: { value: "anthropic-compatible" } });
    fireEvent.change(screen.getByLabelText("기본 URL"), { target: { value: "https://llm.example/v1" } });
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "safe-model" } });
    fireEvent.change(screen.getByLabelText("샌드박스 이미지"), { target: { value: "sandbox:latest" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(saveSetup).toHaveBeenCalledWith({
      kind: "anthropic-compatible",
      baseUrl: "https://llm.example/v1",
      model: "safe-model",
      apiKeyEnv: "",
      sandboxImage: "sandbox:latest",
    }));
    expect(testSetup).not.toHaveBeenCalled();
    expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ apiKeyEnv: "" }),
    }));
    expect(saveCredential).not.toHaveBeenCalled();
    vi.mocked(getSetup).mockResolvedValueOnce({ mode: "workspace", configured: true, settings: {
      kind: "anthropic-compatible", baseUrl: "https://llm.example/v1", model: "safe-model",
      apiKeyEnv: "", sandboxImage: "sandbox:latest", keyAvailable: false,
    } });
    fireEvent.click(screen.getByRole("button", { name: "연결 테스트" }));
    await waitFor(() => expect(testSetup).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("연결 테스트 성공")).toBeInTheDocument();
  });

  it("원격 HTTP 모델 주소도 설정 저장에 전달한다", async () => {
    vi.mocked(saveSetup).mockImplementation(async (settings: SetupSettings) => ({
      mode: "workspace", configured: true, settings: { ...settings, keyAvailable: false },
    }));
    render(<Setup onStatusChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });
    fireEvent.change(screen.getByLabelText("기본 URL"), { target: { value: "http://100.83.9.79:20128/v1" } });
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "gpt-5.6-luna" } });
    fireEvent.change(screen.getByLabelText("샌드박스 이미지"), { target: { value: "a" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(saveSetup).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "http://100.83.9.79:20128/v1", apiKeyEnv: "",
    })));
  });

  it("Codex OAuth를 선택하면 API URL·키 입력 없이 로컬 연결을 저장한다", async () => {
    vi.mocked(saveSetup).mockImplementation(async (fields: SetupSettings) => ({
      mode: "workspace", configured: true, settings: { ...fields, keyAvailable: false },
    }));
    render(<Setup onStatusChange={vi.fn()} />);
    await screen.findByLabelText("제공자 종류");
    fireEvent.change(screen.getByLabelText("제공자 종류"), { target: { value: "openai-codex-oauth" } });
    expect(screen.queryByLabelText("기본 URL")).toBeNull();
    expect(screen.queryByLabelText("API 인증 정보")).toBeNull();
    expect(screen.getByText(/비공식 커뮤니티 어댑터/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "gpt-5.4-mini" } });
    fireEvent.change(screen.getByLabelText("샌드박스 이미지"), { target: { value: "sandbox:latest" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(saveSetup).toHaveBeenCalledWith({
      kind: "openai-codex-oauth", baseUrl: "", apiKeyEnv: "", model: "gpt-5.4-mini", sandboxImage: "sandbox:latest",
    }));
    expect(screen.queryByText(/export .*=/)).toBeNull();
  });

  it("Codex OAuth 인증을 누르면 승인 링크와 서버 상태를 인라인으로 표시한다", async () => {
    const saved: SetupStatus = { mode: "workspace", configured: true, settings: {
      kind: "openai-codex-oauth", baseUrl: "", apiKeyEnv: "", model: "gpt-5.4-mini",
      sandboxImage: "sandbox:latest", keyAvailable: false,
    } };
    vi.mocked(getSetup).mockResolvedValue(saved);
    vi.mocked(getCodexLoginStatus).mockResolvedValue({ state: "pending" });
    render(<Setup onStatusChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Codex OAuth 인증" }));
    await waitFor(() => expect(startCodexLogin).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("link", { name: "인증 페이지 열기" })).toHaveAttribute("href", "https://auth.openai.com/oauth/authorize?state=example");
    expect(screen.getByText(/인증을 기다리는 중/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/토큰 값|인증 코드/)).toBeNull();
  });

  it("기존 로컬 인증이 있으면 재인증 오류 대신 연결 테스트를 안내한다", async () => {
    vi.mocked(getSetup).mockResolvedValue({ mode: "workspace", configured: true, settings: {
      kind: "openai-codex-oauth", baseUrl: "", apiKeyEnv: "", model: "gpt-5.4-mini",
      sandboxImage: "sandbox:latest", keyAvailable: false,
    } });
    vi.mocked(startCodexLogin).mockRejectedValue(new Error("기존 Codex 인증이 있습니다"));
    render(<Setup onStatusChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Codex OAuth 인증" }));
    expect(await screen.findByText(/기존 로컬 인증이 있습니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "연결 테스트" })).toBeEnabled();
  });

  it("Codex OAuth에서 API 키 방식으로 돌아오면 URL과 인증 정보 입력을 다시 표시한다", async () => {
    render(<Setup onStatusChange={vi.fn()} />);
    await screen.findByLabelText("제공자 종류");
    fireEvent.change(screen.getByLabelText("제공자 종류"), { target: { value: "openai-codex-oauth" } });
    fireEvent.change(screen.getByLabelText("제공자 종류"), { target: { value: "openai-compatible" } });
    expect(screen.getByLabelText("기본 URL")).toBeRequired();
    expect(screen.getByLabelText("API 인증 정보")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "인증 정보 저장" })).toBeDisabled();
  });

  it("stores a synthetic credential separately, clears the password, and never leaks it into settings or text", async () => {
    const token = `synthetic-credential-${"x".repeat(24)}`;
    const saved = { ...configured, settings: { ...configured.settings!, keyAvailable: true } };
    vi.mocked(getSetup).mockResolvedValueOnce(configured).mockResolvedValue(saved);
    const onStatusChange = vi.fn();
    render(<Setup onStatusChange={onStatusChange} />);
    const field = await screen.findByLabelText("API 인증 정보");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveValue("");
    fireEvent.change(field, { target: { value: token } });
    fireEvent.click(screen.getByRole("button", { name: "인증 정보 저장" }));
    await waitFor(() => expect(saveCredential).toHaveBeenCalledWith(token, {
      kind: configured.settings!.kind, baseUrl: configured.settings!.baseUrl,
    }));
    await waitFor(() => expect(field).toHaveValue(""));
    expect(screen.getByText(/인증 정보: 서버 저장소에 저장됨/)).toBeInTheDocument();
    expect(onStatusChange).toHaveBeenLastCalledWith(saved);
    expect(saveSetup).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent(token);
  });

  it("does not reflect a credential-store failure or retain the entered secret in page text", async () => {
    const token = `synthetic-credential-${"z".repeat(24)}`;
    vi.mocked(getSetup).mockResolvedValue(configured);
    vi.mocked(saveCredential).mockRejectedValueOnce(new Error(`server-error-${token}`));
    render(<Setup onStatusChange={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("API 인증 정보"), { target: { value: token } });
    fireEvent.click(screen.getByRole("button", { name: "인증 정보 저장" }));
    expect(await screen.findByText("인증 정보를 저장하지 못했습니다.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(token);
    expect(saveSetup).not.toHaveBeenCalled();
  });

  it("rejects a pasted token in the URL before calling saveSetup or reflecting it in help text", async () => {
    const token = `sk-proj-${"q".repeat(32)}`;
    render(<Setup onStatusChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });
    fireEvent.change(screen.getByLabelText("기본 URL"), { target: { value: `https://llm.example/v1/${token}` } });
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "safe-model" } });
    fireEvent.change(screen.getByLabelText("샌드박스 이미지"), { target: { value: "sandbox:latest" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    expect(vi.mocked(saveSetup).mock.calls.length).toBe(0);
    expect(await screen.findByText(/설정 항목을 확인해 주세요/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(token);
  });

  it("allows a keyless loopback provider, sends an empty env name, and never suggests an empty export", async () => {
    vi.mocked(saveSetup).mockImplementation(async (fields: SetupSettings) => ({
      mode: "workspace", configured: true, settings: { ...fields, keyAvailable: false },
    }));
    render(<Setup onStatusChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });
    fireEvent.change(screen.getByLabelText("기본 URL"), { target: { value: "http://[::1]:11434/v1" } });
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "safe-model" } });
    fireEvent.change(screen.getByLabelText("샌드박스 이미지"), { target: { value: "sandbox:latest" } });
    expect(screen.getByLabelText("API 인증 정보")).not.toBeRequired();
    expect(screen.getByRole("button", { name: "인증 정보 저장" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(saveSetup).toHaveBeenCalledWith(expect.objectContaining({ apiKeyEnv: "" })));
    expect(await screen.findByText(/인증 정보: 저장되지 않음/)).toBeInTheDocument();
    expect(screen.queryByText(/export .*=/)).toBeNull();
    expect(saveCredential).not.toHaveBeenCalled();
  });

  it("allows saving a remote provider without putting a credential in settings", async () => {
    render(<Setup onStatusChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });
    fireEvent.change(screen.getByLabelText("기본 URL"), { target: { value: "https://llm.example/v1" } });
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "safe-model" } });
    fireEvent.change(screen.getByLabelText("샌드박스 이미지"), { target: { value: "sandbox:latest" } });
    expect(screen.getByRole("button", { name: "인증 정보 저장" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(saveSetup).toHaveBeenCalledWith(expect.objectContaining({ apiKeyEnv: "" })));
    expect(saveCredential).not.toHaveBeenCalled();
  });

  it("샘플 실행 버튼 없이 설정으로 바로가기만 제공한다", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "첫 실행 설정" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "샘플 분석 실행" })).toBeNull();
    expect(screen.getByRole("button", { name: "설정" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("navigation", { name: "주 메뉴" })).getByRole("button", { name: "결과 확인" }));
    expect(screen.getAllByText("분석 결과 없음").length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "요약 지표" })).toBeInTheDocument();
  });

  it("explains the workspace restart after saving while the server remains in fixture mode", async () => {
    vi.mocked(saveSetup).mockImplementation(async (fields: SetupSettings) => ({
      mode: "fixture", configured: true, settings: { ...fields, keyAvailable: false },
    }));
    render(<App />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });
    fireEvent.change(screen.getByLabelText("기본 URL"), { target: { value: "https://llm.example/v1" } });
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "safe-model" } });
    fireEvent.change(screen.getByLabelText("샌드박스 이미지"), { target: { value: "sandbox:latest" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    expect(await screen.findByText(/TRUSTGATE_MODE=workspace/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "샘플 분석 실행" })).toBeNull();
    expect(screen.queryByRole("region", { name: "프로젝트 분석" })).toBeNull();
  });

  it("shows fixed failure text and retry when status is offline", async () => {
    vi.mocked(getSetup).mockRejectedValueOnce(new Error("server-private-key"));
    render(<Setup onStatusChange={vi.fn()} />);
    expect(await screen.findByText("설정 서버에 연결하지 못했습니다. 다시 시도해 주세요.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("server-private-key");
    fireEvent.click(screen.getByRole("button", { name: "설정 다시 불러오기" }));
    expect(await screen.findByRole("heading", { name: "첫 실행 설정" })).toBeInTheDocument();
  });

  it("does not echo a server error after save or test fails", async () => {
    vi.mocked(saveSetup).mockRejectedValueOnce(new Error("upstream-secret-in-error"));
    vi.mocked(testSetup).mockRejectedValueOnce(new Error("upstream-secret-in-error"));
    render(<Setup onStatusChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });
    fireEvent.change(screen.getByLabelText("기본 URL"), { target: { value: "https://llm.example/v1" } });
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "safe-model" } });
    fireEvent.change(screen.getByLabelText("샌드박스 이미지"), { target: { value: "sandbox:latest" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    expect(await screen.findByText("설정을 저장하지 못했습니다. 항목을 확인한 뒤 다시 시도해 주세요.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "연결 테스트" })).toBeDisabled();
    vi.mocked(saveSetup).mockImplementationOnce(async (fields: SetupSettings) => ({
      mode: "workspace", configured: true, settings: { ...fields, keyAvailable: false },
    }));
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "연결 테스트" })).toBeEnabled());
    vi.mocked(getSetup).mockResolvedValueOnce({ mode: "workspace", configured: true, settings: {
      kind: "openai-compatible", baseUrl: "https://llm.example/v1", model: "safe-model",
      apiKeyEnv: "", sandboxImage: "sandbox:latest", keyAvailable: false,
    } });
    fireEvent.click(screen.getByRole("button", { name: "연결 테스트" }));
    expect(await screen.findByText("연결 테스트에 실패했습니다. 서버 설정을 확인해 주세요.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("upstream-secret-in-error");
  });

  it("locks every setting field while save and test requests are in flight", async () => {
    vi.mocked(getSetup).mockResolvedValue(configured);
    let completeSave: ((status: SetupStatus) => void) | undefined;
    let completeTest: (() => void) | undefined;
    vi.mocked(saveSetup).mockReturnValue(new Promise((resolve) => { completeSave = resolve; }));
    vi.mocked(testSetup).mockReturnValue(new Promise((resolve) => { completeTest = resolve; }));
    render(<Setup onStatusChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "연결 설정" });
    const model = screen.getByLabelText("모델");
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    for (const name of ["제공자 종류", "기본 URL", "모델", "API 인증 정보", "샌드박스 이미지"]) {
      expect(screen.getByLabelText(name)).toBeDisabled();
    }
    fireEvent.change(model, { target: { value: "stale-model" } });
    expect(model).toHaveValue("my-model");
    completeSave?.(configured);
    await waitFor(() => expect(model).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "연결 테스트" }));
    expect(model).toBeDisabled();
    fireEvent.change(model, { target: { value: "stale-model" } });
    expect(model).toHaveValue("my-model");
    completeTest?.();
    expect(await screen.findByText("연결 테스트 성공")).toBeInTheDocument();
    expect(model).toBeEnabled();
  });

  it("does not report a connection test success when another tab changed the persisted setup", async () => {
    const changed: SetupStatus = { ...configured, settings: { ...configured.settings!, model: "other-tab-model", apiKeyEnv: "OTHER_TAB_KEY" } };
    const onStatusChange = vi.fn();
    vi.mocked(getSetup).mockResolvedValueOnce(configured).mockResolvedValueOnce(changed).mockResolvedValue(changed);
    render(<Setup onStatusChange={onStatusChange} />);
    await screen.findByRole("heading", { name: "연결 설정" });
    expect(screen.getByLabelText("모델")).toHaveValue("my-model");
    fireEvent.click(screen.getByRole("button", { name: "연결 테스트" }));
    await waitFor(() => expect(getSetup).toHaveBeenCalledTimes(2));
    expect(testSetup).not.toHaveBeenCalled();
    expect(screen.queryByText("연결 테스트 성공")).toBeNull();
    expect(await screen.findByText(/서버 설정이 변경되었습니다/)).toBeInTheDocument();
    expect(screen.getByLabelText("모델")).toHaveValue("my-model");
    expect(screen.getByRole("button", { name: "연결 테스트" })).toBeDisabled();
    expect(onStatusChange).toHaveBeenLastCalledWith(changed);
    fireEvent.click(screen.getByRole("button", { name: "설정 다시 불러오기" }));
    await waitFor(() => expect(screen.getByLabelText("모델")).toHaveValue("other-tab-model"));
    expect(getSetup).toHaveBeenCalledTimes(3);
  });

  it("requires saving a changed draft before testing the persisted configuration", async () => {
    vi.mocked(getSetup).mockResolvedValue(configured);
    render(<Setup onStatusChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "연결 설정" });
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "different-model" } });
    expect(screen.getByRole("button", { name: "연결 테스트" })).toBeDisabled();
    expect(screen.getByText(/변경된 설정을 먼저 저장/)).toBeInTheDocument();
    expect(testSetup).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "my-model" } });
    expect(screen.getByRole("button", { name: "연결 테스트" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "연결 테스트" }));
    await waitFor(() => expect(testSetup).toHaveBeenCalledTimes(1));
  });

  it("does not start another save while a save is pending", async () => {
    let complete: ((status: SetupStatus) => void) | undefined;
    vi.mocked(saveSetup).mockReturnValue(new Promise<SetupStatus>((resolve) => { complete = resolve; }));
    render(<Setup onStatusChange={vi.fn()} />);
    await screen.findByRole("heading", { name: "첫 실행 설정" });
    fireEvent.change(screen.getByLabelText("기본 URL"), { target: { value: "https://llm.example/v1" } });
    fireEvent.change(screen.getByLabelText("모델"), { target: { value: "safe-model" } });
    fireEvent.change(screen.getByLabelText("샌드박스 이미지"), { target: { value: "sandbox:latest" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));
    expect(screen.getByRole("button", { name: "저장하는 중…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "연결 테스트" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "저장하는 중…" }));
    expect(saveSetup).toHaveBeenCalledTimes(1);
    complete?.({ mode: "fixture", configured: true, settings: {
      kind: "openai-compatible", baseUrl: "https://llm.example/v1", model: "safe-model",
      apiKeyEnv: "", sandboxImage: "sandbox:latest", keyAvailable: false,
    } });
    expect(await screen.findByText(/설정을 저장했습니다/)).toBeInTheDocument();
  });

  it("does not show fixture evidence or completed stages during or after a failed workspace attempt", async () => {
    vi.mocked(getSetup).mockResolvedValue(configured);
    let fail: ((reason: Error) => void) | undefined;
    vi.mocked(startWorkspaceRun).mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    render(<App />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "주 메뉴" })).getByRole("button", { name: "프로젝트 선택/분석" }));
    const workspace = await screen.findByRole("region", { name: "프로젝트 분석" });
    fireEvent.click(within(workspace).getByRole("button", { name: "프로젝트 분석" }));
    const summary = screen.getByRole("region", { name: "요약 지표" });
    const flow = screen.getByRole("region", { name: "분석 흐름" });
    const evidence = screen.getByRole("region", { name: "실행 증거" });
    expect(summary).toHaveTextContent("프로젝트 분석 대기 중");
    expect(summary).not.toHaveTextContent("OCR 수집");
    expect(flow).not.toHaveTextContent("server.ts, store.ts");
    expect(flow).not.toHaveTextContent("수집 완료");
    expect(evidence).not.toHaveTextContent("POST /api/purchase");
    expect(evidence).toHaveTextContent("실행 증거 없음");
    fail?.(new Error("synthetic failure"));
    expect(await screen.findByText(/프로젝트 분석에 실패했습니다/)).toBeInTheDocument();
    expect(summary).toHaveTextContent("프로젝트 분석 실패");
    expect(summary).not.toHaveTextContent("OCR 수집");
    expect(flow).not.toHaveTextContent("수집 완료");
    expect(evidence).toHaveTextContent("실행 증거 없음");
    expect(evidence).not.toHaveTextContent("HTTP 400");
  });

  it("shows a separate workspace action only after workspace configuration and labels its report as workspace", async () => {
    vi.mocked(getSetup).mockResolvedValue(configured);
    vi.mocked(startWorkspaceRun).mockResolvedValue({
      runId: "run-workspace-1",
      provider: "openai-compatible",
      model: "my-model",
      reviewedFiles: ["src/app.ts"],
      hypotheses: [],
      regressionVerdict: "UNVERIFIED",
      durations: { totalMs: 21, ocrMs: 1, planningMs: 10, vulnerableMs: 5, patchedMs: 5 },
      source: "workspace",
    });
    render(<App />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "주 메뉴" })).getByRole("button", { name: "프로젝트 선택/분석" }));
    const workspace = await screen.findByRole("region", { name: "프로젝트 분석" });
    expect(screen.queryByRole("button", { name: "샘플 분석 실행" })).toBeNull();
    expect(within(workspace).getByRole("button", { name: "프로젝트 분석" })).toBeEnabled();
    fireEvent.change(within(workspace).getByLabelText("저장소 상대 경로"), { target: { value: "apps/demo-target" } });
    fireEvent.click(within(workspace).getByRole("button", { name: "프로젝트 분석" }));
    await waitFor(() => expect(startWorkspaceRun).toHaveBeenCalledWith("apps/demo-target"));
    expect(await screen.findByText("실제 실행 결과")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "요약 지표" })).toHaveTextContent("1");
    expect(screen.getByRole("region", { name: "분석 흐름" })).not.toHaveTextContent("fixture 분석의 단계별 결과");
  });
});

describe("setup API trust boundary", () => {
  it("reads and validates status without allowing an arbitrary secret field in the UI model", async () => {
    const { getSetup: actualGetSetup } = await vi.importActual<typeof import("./lib/setup")>("./lib/setup");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...configured, settings: { ...configured.settings, apiKey: "do-not-render" } }), { status: 200 }));
    expect(await actualGetSetup(fetcher)).toEqual(configured);
    expect(fetcher).toHaveBeenCalledWith("/api/setup", expect.objectContaining({ method: "GET", cache: "no-store" }));
  });

  it("refuses an unsafe environment variable name in the export guidance", async () => {
    const { getSetup: actualGetSetup } = await vi.importActual<typeof import("./lib/setup")>("./lib/setup");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ...configured, settings: { ...configured.settings, apiKeyEnv: "SAFE_KEY;run-malicious-command" },
    }), { status: 200 }));
    await expect(actualGetSetup(fetcher)).rejects.toThrow("설정 응답 형식이 올바르지 않습니다");
  });

  it("refuses credential-shaped environment names returned by the server before export guidance", async () => {
    const { getSetup: actualGetSetup } = await vi.importActual<typeof import("./lib/setup")>("./lib/setup");
    const token = `ghp_${"A".repeat(36)}`;
    await expect(actualGetSetup(async () => new Response(JSON.stringify({
      ...configured, settings: { ...configured.settings, apiKeyEnv: token },
    }), { status: 200 }))).rejects.toThrow("설정 응답 형식이 올바르지 않습니다");
  });

  it("blocks recognizable literals in all persisted fields before POST and before GET reflection", async () => {
    const { getSetup: actualGetSetup, saveSetup: actualSaveSetup } = await vi.importActual<typeof import("./lib/setup")>("./lib/setup");
    const safe: SetupSettings = { kind: "openai-compatible", baseUrl: "https://llm.example/v1", model: "safe-model", apiKeyEnv: "", sandboxImage: "localhost/trustgate-target:latest" };
    const candidates: SetupSettings[] = [
      { ...safe, apiKeyEnv: `AIza${"a".repeat(35)}` },
      { ...safe, baseUrl: `https://llm.example/v1/sk-proj-${"b".repeat(32)}` },
      { ...safe, model: `model-gho_${"c".repeat(36)}` },
      { ...safe, model: `model_gho_${"c".repeat(36)}` },
      { ...safe, sandboxImage: `localhost/sk-proj-${"d".repeat(32)}:latest` },
    ];
    for (const unsafe of candidates) {
      const fetcher = vi.fn();
      await expect(actualSaveSetup(unsafe, fetcher)).rejects.toThrow("설정 요청이 실패했습니다");
      expect(fetcher).not.toHaveBeenCalled();
      await expect(actualGetSetup(async () => new Response(JSON.stringify({
        mode: "workspace", configured: true, settings: { ...unsafe, keyAvailable: false },
      }), { status: 200 }))).rejects.toThrow("설정 응답 형식이 올바르지 않습니다");
    }
    expect(safe).toMatchObject({ apiKeyEnv: "", baseUrl: "https://llm.example/v1", sandboxImage: "localhost/trustgate-target:latest" });
  });

  it("does not POST a credential literal even if saveSetup is called outside the form", async () => {
    const { saveSetup: actualSaveSetup } = await vi.importActual<typeof import("./lib/setup")>("./lib/setup");
    const fetcher = vi.fn();
    await expect(actualSaveSetup({
      kind: "openai-compatible", baseUrl: "https://llm.example/v1", model: "safe-model",
      apiKeyEnv: `ghp_${"A".repeat(36)}`, sandboxImage: "sandbox:latest",
    }, fetcher)).rejects.toThrow("설정 요청이 실패했습니다");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts a non-loopback setting before its credential is saved", async () => {
    const { getSetup: actualGetSetup } = await vi.importActual<typeof import("./lib/setup")>("./lib/setup");
    await expect(actualGetSetup(async () => new Response(JSON.stringify({
      ...configured, settings: { ...configured.settings, baseUrl: "https://llm.example/v1", apiKeyEnv: "" },
    }), { status: 200 }))).resolves.toMatchObject({ settings: { apiKeyEnv: "", keyAvailable: false } });
  });

  it("posts only the five settings, and discards response bodies on failure", async () => {
    const { saveSetup: actualSaveSetup } = await vi.importActual<typeof import("./lib/setup")>("./lib/setup");
    const settings = { kind: "openai-compatible" as const, baseUrl: "https://llm.example/v1", model: "safe-model", apiKeyEnv: "", sandboxImage: "sandbox:latest" };
    const saved = { ...configured, settings: { ...settings, keyAvailable: false } };
    const fetcher = vi.fn(async (_input: string, _init: RequestInit) => new Response(JSON.stringify(saved), { status: 200 }));
    expect(await actualSaveSetup(settings, fetcher)).toEqual(saved);
    expect(fetcher).toHaveBeenCalledWith("/api/setup", expect.objectContaining({
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(settings),
    }));
    expect(fetcher).toHaveBeenCalledWith("/api/setup", expect.objectContaining({ method: "GET", cache: "no-store" }));
    await expect(actualSaveSetup(settings, async () => new Response("sensitive upstream response", { status: 500 })))
      .rejects.toThrow("설정 요청이 실패했습니다");
  });

  it("reads back the persisted settings before reporting a successful save", async () => {
    const { saveSetup: actualSaveSetup } = await vi.importActual<typeof import("./lib/setup")>("./lib/setup");
    const form: SetupSettings = { kind: "openai-compatible", baseUrl: "https://llm.example/v1", model: "safe-model", apiKeyEnv: "", sandboxImage: "sandbox:latest" };
    const returned = { ...configured, settings: { ...form, keyAvailable: false } };
    const fetcher = vi.fn(async (input: string, init: RequestInit) =>
      new Response(JSON.stringify(input === "/api/setup" && init.method === "GET" ? emptyFixture : returned), { status: 200 }));
    await expect(actualSaveSetup(form, fetcher)).rejects.toThrow("설정 요청이 실패했습니다");
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/setup", expect.objectContaining({ method: "GET", cache: "no-store" }));
  });

  it("tests persisted settings without sending the form, and fails closed on malformed responses", async () => {
    const { testSetup: actualTestSetup } = await vi.importActual<typeof import("./lib/setup")>("./lib/setup");
    const fetcher = vi.fn(async (_input: string, _init: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await actualTestSetup(fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/setup/test", expect.objectContaining({ method: "POST" }));
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("body");
    await expect(actualTestSetup(async () => new Response(JSON.stringify({ ok: false }), { status: 200 })))
      .rejects.toThrow("설정 응답 형식이 올바르지 않습니다");
  });

  it("rejects whitespace-only workspace paths but treats literal empty as the default root", async () => {
    const { startWorkspaceRun: actualStartWorkspaceRun } = await vi.importActual<typeof import("./lib/setup")>("./lib/setup");
    const report = {
      runId: "run-root", provider: "openai-compatible", model: "my-model", reviewedFiles: [], hypotheses: [],
      regressionVerdict: "UNVERIFIED", durations: { totalMs: 1, ocrMs: 0, planningMs: 0, vulnerableMs: 0, patchedMs: 0 }, source: "workspace",
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(report), { status: 201 }));
    await expect(actualStartWorkspaceRun("   ", fetcher)).rejects.toThrow("허용된 저장소 상대 경로를 입력해 주세요");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(actualStartWorkspaceRun("", fetcher)).resolves.toEqual(report);
    expect(fetcher).toHaveBeenCalledWith("/api/runs", expect.objectContaining({
      body: JSON.stringify({ source: "workspace" }),
    }));
  });

  it("posts a workspace run with a relative path and rejects an invalid report", async () => {
    const { startWorkspaceRun: actualStartWorkspaceRun } = await vi.importActual<typeof import("./lib/setup")>("./lib/setup");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ runId: "bad" }), { status: 201 }));
    await expect(actualStartWorkspaceRun("apps/demo-target", fetcher)).rejects.toThrow("분석 응답 형식이 올바르지 않습니다");
    expect(fetcher).toHaveBeenCalledWith("/api/runs", expect.objectContaining({
      method: "POST", body: JSON.stringify({ source: "workspace", repoPath: "apps/demo-target" }),
    }));
    await expect(actualStartWorkspaceRun("../outside", fetcher)).rejects.toThrow("허용된 저장소 상대 경로를 입력해 주세요");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a bodyless setup response with a fixed error instead of hanging", async () => {
    const { getSetup: actualGetSetup } = await vi.importActual<typeof import("./lib/setup")>("./lib/setup");
    class BodylessXhr {
      status = 204;
      responseText = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open() { /* no-op */ }
      setRequestHeader() { /* no-op */ }
      send() { this.onload?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", BodylessXhr);
    try {
      await expect(Promise.race([
        actualGetSetup(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("request hung")), 100)),
      ])).rejects.toThrow("설정 응답 형식이 올바르지 않습니다");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("aborts an oversized setup response before it reaches React state", async () => {
    const { getSetup: actualGetSetup } = await vi.importActual<typeof import("./lib/setup")>("./lib/setup");
    class OversizedXhr {
      status = 200;
      responseText = "secret-value".repeat(2_000);
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      onprogress: ((event: ProgressEvent) => void) | null = null;
      abort = vi.fn();
      open() { /* no-op */ }
      setRequestHeader() { /* no-op */ }
      send() { this.onprogress?.({ loaded: this.responseText.length } as ProgressEvent); }
    }
    vi.stubGlobal("XMLHttpRequest", OversizedXhr);
    try {
      await expect(Promise.race([
        actualGetSetup(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("request hung")), 100)),
      ])).rejects.toThrow("설정 응답 형식이 올바르지 않습니다");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
