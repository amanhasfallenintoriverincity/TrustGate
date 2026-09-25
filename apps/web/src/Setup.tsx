import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { cancelCodexLogin, getSetup, getCodexLoginStatus, isSafeSetupFields, saveCredential, saveSetup, startCodexLogin, testSetup } from "./lib/setup";
import type { SetupSettings, SetupStatus } from "./lib/setup";

const INITIAL: SetupSettings = {
  kind: "openai-compatible", baseUrl: "", model: "", apiKeyEnv: "", sandboxImage: "",
};
type LoadState = "loading" | "ready" | "error";
type ActionState = "idle" | "saving" | "testing";

/** Inline first-run panel. Credentials go to a separate server-side store. */
export default function Setup({ onStatusChange, openSignal }: { readonly onStatusChange: (status: SetupStatus) => void; readonly openSignal?: number }): JSX.Element {
  const [load, setLoad] = useState<LoadState>("loading");
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [settings, setSettings] = useState<SetupSettings>(INITIAL);
  const [collapsed, setCollapsed] = useState(false);
  const [action, setAction] = useState<ActionState>("idle");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loginState, setLoginState] = useState<"idle" | "pending" | "ready" | "error" | "existing">("idle");
  const [loginUrl, setLoginUrl] = useState("");
  const [credential, setCredential] = useState("");
  const mounted = useRef(true);
  const lock = useRef(false);
  const requestNumber = useRef(0);

  const codexOAuth = settings.kind === "openai-codex-oauth";
  const saved = status?.settings;
  const draftMatchesSaved = saved !== null && saved !== undefined &&
    settings.kind === saved.kind && (codexOAuth || settings.baseUrl.trim() === saved.baseUrl) &&
    settings.model.trim() === saved.model && settings.apiKeyEnv.trim() === saved.apiKeyEnv &&
    settings.sandboxImage.trim() === saved.sandboxImage;

  useEffect(() => {
    if (openSignal !== undefined && openSignal > 0) setCollapsed(false);
  }, [openSignal]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestNumber.current += 1; };
  }, []);

  const reload = (): void => {
    const request = ++requestNumber.current;
    setLoad("loading");
    setError("");
    void getSetup().then((next) => {
      if (!mounted.current || request !== requestNumber.current) return;
      setLoad("ready");
      setStatus(next);
      if (next.settings !== null) {
        const { kind, baseUrl, model, apiKeyEnv, sandboxImage } = next.settings;
        setSettings({ kind, baseUrl, model, apiKeyEnv, sandboxImage });
      }
      onStatusChange(next);
    }, () => {
      if (!mounted.current || request !== requestNumber.current) return;
      setLoad("error");
      setError("설정 서버에 연결하지 못했습니다. 다시 시도해 주세요.");
    });
  };

  useEffect(() => {
    reload();
    // Discovery runs on mount; explicit retry is a user action, not an effect dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loginState !== "pending") return;
    const timer = window.setInterval(() => {
      void getCodexLoginStatus().then((status) => {
        if (mounted.current) setLoginState(status.state);
      }, () => { if (mounted.current) setLoginState("error"); });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [loginState]);

  const login = (): void => {
    if (loginState === "pending") return;
    setLoginUrl("");
    setLoginState("pending");
    void startCodexLogin().then(({ url }) => {
      if (mounted.current) setLoginUrl(url);
    }, (reason: unknown) => {
      if (mounted.current) setLoginState(reason instanceof Error && reason.message === "기존 Codex 인증이 있습니다" ? "existing" : "error");
    });
  };

  const cancelLogin = (): void => {
    void cancelCodexLogin().then(() => {
      if (mounted.current) { setLoginUrl(""); setLoginState("idle"); }
    }, () => { if (mounted.current) setLoginState("error"); });
  };

  const update = <K extends keyof SetupSettings>(key: K, value: SetupSettings[K]): void => {
    if (lock.current) return;
    setSettings((previous) => key === "kind" && value === "openai-codex-oauth"
      ? { ...previous, kind: "openai-codex-oauth", baseUrl: "", apiKeyEnv: "" }
      : { ...previous, [key]: value });
    setMessage("");
    setError("");
  };

  const storeCredential = (): void => {
    if (lock.current || codexOAuth || credential.length === 0 || !draftMatchesSaved) return;
    lock.current = true;
    setAction("saving");
    setMessage("");
    setError("");
    void (async () => {
      await saveCredential(credential, { kind: settings.kind, baseUrl: settings.baseUrl });
      setCredential("");
      const next = await getSetup();
      if (mounted.current) { setStatus(next); onStatusChange(next); setMessage("인증 정보를 저장했습니다."); }
    })().catch(() => {
      if (mounted.current) setError("인증 정보를 저장하지 못했습니다.");
    }).finally(() => {
      lock.current = false;
      if (mounted.current) setAction("idle");
    });
  };

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (lock.current) return;
    if (!isSafeSetupFields(settings)) {
      setError("설정 항목을 확인해 주세요.");
      return;
    }
    lock.current = true;
    setAction("saving");
    setMessage("");
    setError("");
    const payload: SetupSettings = {
      kind: settings.kind, baseUrl: codexOAuth ? "" : settings.baseUrl.trim(), model: settings.model.trim(),
      apiKeyEnv: "", sandboxImage: settings.sandboxImage.trim(),
    };
    void saveSetup(payload).then((next) => {
      if (!mounted.current) return;
      setStatus(next);
      onStatusChange(next);
      setMessage("설정을 저장했습니다. 연결 테스트는 별도로 실행해 주세요.");
    }, () => {
      if (mounted.current) setError("설정을 저장하지 못했습니다. 항목을 확인한 뒤 다시 시도해 주세요.");
    }).finally(() => {
      lock.current = false;
      if (mounted.current) setAction("idle");
    });
  };

  const testConnection = (): void => {
    if (lock.current || !draftMatchesSaved) return;
    lock.current = true;
    setAction("testing");
    setMessage("");
    setError("");
    void (async () => {
      // Another tab may have replaced the saved settings since this draft was loaded.
      const latest = await getSetup();
      if (!mounted.current) return;
      const current = latest.settings;
      if (!latest.configured || current === null ||
          current.kind !== settings.kind || (!codexOAuth && current.baseUrl !== settings.baseUrl.trim()) ||
          current.model !== settings.model.trim() || (!codexOAuth && current.apiKeyEnv !== settings.apiKeyEnv.trim()) ||
          current.sandboxImage !== settings.sandboxImage.trim()) {
        setStatus(latest);
        onStatusChange(latest);
        setError("서버 설정이 변경되었습니다. 설정을 다시 불러오거나 현재 항목을 저장한 뒤 테스트해 주세요.");
        return;
      }
      await testSetup();
      if (mounted.current) setMessage("연결 테스트 성공");
    })().catch(() => {
      if (mounted.current) setError("연결 테스트에 실패했습니다. 서버 설정을 확인해 주세요.");
    }).finally(() => {
      lock.current = false;
      if (mounted.current) setAction("idle");
    });
  };

  return (
    <Card as="section" className="surface setup" id="setup" aria-labelledby="setup-title">
      <CardHeader className="section-head">
        <h2 id="setup-title">{status?.configured ? "연결 설정" : "첫 실행 설정"}</h2>
        {load === "ready" && (
          <Button variant="outline" size="sm" type="button" aria-expanded={!collapsed} aria-controls="setup-content"
            onClick={() => setCollapsed((was) => !was)}>
            {collapsed ? "설정 펼치기" : "설정 접기"}
          </Button>
        )}
      </CardHeader>
      <div id="setup-content" hidden={collapsed}>
        {load === "loading" && <p className="section-note">설정을 확인하는 중입니다…</p>}
        {load === "error" && (
          <div className="setup-stack">
            <p role="alert">{error}</p>
            <Button variant="outline" size="sm" type="button" onClick={reload}>설정 다시 불러오기</Button>
            <p className="section-note">설정 조회만 실패했습니다. 실행 서버 상태와 프로젝트 분석 경로를 확인해 주세요.</p>
          </div>
        )}
        {load === "ready" && status !== null && (
          <div className="setup-stack">
            <p className="section-note">
              {status.configured ? "저장된 설정을 확인하거나 변경할 수 있습니다." : "처음 실행하는 경우 여기서 제공자와 샌드박스 정보를 설정합니다."}
            </p>
            <form onSubmit={save}>
              <FieldGroup className="setup-form">
                <Field><FieldLabel htmlFor="provider-kind">제공자 종류</FieldLabel>
                  <NativeSelect id="provider-kind" disabled={action !== "idle"} value={settings.kind} onChange={(event) => update("kind", event.target.value as SetupSettings["kind"])}>
                    <NativeSelectOption value="openai-compatible">OpenAI-compatible (기본)</NativeSelectOption>
                    <NativeSelectOption value="anthropic-compatible">Anthropic-compatible</NativeSelectOption>
                    <NativeSelectOption value="openai-codex-oauth">Codex OAuth (로컬·비공식)</NativeSelectOption>
                  </NativeSelect>
                </Field>
                {!codexOAuth && <Field><FieldLabel htmlFor="base-url">기본 URL</FieldLabel>
                  <Input id="base-url" type="url" required disabled={action !== "idle"} maxLength={2048} spellCheck={false} autoComplete="off"
                    value={settings.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.example/v1" />
                </Field>}
                <Field><FieldLabel htmlFor="model">모델</FieldLabel>
                  <Input id="model" required disabled={action !== "idle"} maxLength={256} spellCheck={false} autoComplete="off" value={settings.model}
                    onChange={(event) => update("model", event.target.value)} placeholder="model-name" />
                </Field>
                {!codexOAuth && <Field><FieldLabel htmlFor="api-credential">API 인증 정보</FieldLabel>
                  <Input id="api-credential" type="password" disabled={action !== "idle"} maxLength={4096} spellCheck={false}
                    autoComplete="new-password" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder={status.settings?.keyAvailable ? "저장된 인증 정보 있음 (변경 시 입력)" : "API 키 입력"} />
                </Field>}
                <Field><FieldLabel htmlFor="sandbox-image">샌드박스 이미지</FieldLabel>
                  <Input id="sandbox-image" required disabled={action !== "idle"} maxLength={256} spellCheck={false} autoComplete="off" value={settings.sandboxImage}
                    onChange={(event) => update("sandboxImage", event.target.value)} placeholder="trustgate-sandbox:local" />
                </Field>
                <p className="section-note setup-full">{codexOAuth ? "Codex OAuth는 비공식 커뮤니티 어댑터를 사용하는 로컬 단일 사용자 선택 기능입니다. 서버에서 인증한 계정의 권한·약관을 확인하세요. 토큰은 이 페이지에 입력하거나 저장하지 않습니다. 연결 테스트는 실제 모델 요청을 보냅니다." : "API 인증 정보는 서버의 별도 저장소에 보관합니다. 설정을 먼저 저장하고 인증 정보를 저장하세요. 연결 테스트는 실제 모델 요청을 보냅니다."}</p>
                {codexOAuth && <div className="setup-full setup-stack">
                  <Button type="button" variant="outline" disabled={loginState === "pending"} onClick={login}>Codex OAuth 인증</Button>
                  {loginUrl && loginState === "pending" && <a href={loginUrl} target="_blank" rel="noopener noreferrer">인증 페이지 열기</a>}
                  {loginState === "pending" && <Button type="button" variant="ghost" onClick={cancelLogin}>인증 취소</Button>}
                  <p className="section-note" role="status">{loginState === "pending" ? "인증을 기다리는 중입니다. 브라우저에서 승인을 완료하세요." : loginState === "ready" ? "인증이 완료되었습니다. 연결 테스트로 모델 사용 가능 여부를 확인하세요." : loginState === "existing" ? "기존 로컬 인증이 있습니다. 연결 테스트로 사용 가능 여부를 확인하세요." : loginState === "error" ? "인증을 완료하지 못했습니다. 다시 시도해 주세요." : "인증 버튼을 누르면 별도 브라우저 탭에서 승인합니다."}</p>
                </div>}
                <div className="setup-actions setup-full">
                  <Button type="submit" size="lg" disabled={action !== "idle"}>{action === "saving" ? "저장하는 중…" : "설정 저장"}</Button>
                  {!codexOAuth && <Button type="button" variant="outline" size="lg" disabled={action !== "idle" || !draftMatchesSaved || !credential} onClick={storeCredential}>인증 정보 저장</Button>}
                  <Button type="button" variant="outline" size="lg" disabled={action !== "idle" || !draftMatchesSaved} onClick={testConnection}>{action === "testing" ? "테스트 중…" : "연결 테스트"}</Button>
                </div>
                {!draftMatchesSaved && <p className="section-note setup-full">변경된 설정을 먼저 저장한 뒤 연결 테스트를 실행해 주세요. 테스트는 서버에 저장된 설정을 사용합니다.</p>}
              </FieldGroup>
            </form>
            {status.settings !== null && <div className="setup-stack">
              {status.settings.kind === "openai-codex-oauth" ? <p className="section-note">Codex OAuth는 서버의 로컬 인증 정보를 사용합니다. 연결 테스트로 사용 가능 여부를 확인하세요.</p> : <p className="section-note">인증 정보: {status.settings.keyAvailable ? "서버 저장소에 저장됨" : "저장되지 않음 (키 없는 로컬 모델은 그대로 사용 가능)"}</p>}
            </div>}
            {status.mode === "fixture" && <p className="section-note">샘플 모드는 별개입니다. 프로젝트 분석은 허용할 저장소의 절대 경로를 <code>TRUSTGATE_WORKSPACE_ROOT</code>로 지정하고, 서버를 <code>TRUSTGATE_MODE=workspace</code>로 다시 시작하세요.</p>}
            {status.mode === "workspace" && !status.configured && <p className="section-note">프로젝트 분석은 설정을 저장한 다음 사용할 수 있습니다.</p>}
            <p className="setup-message" aria-live="polite">{message || (load === "ready" ? error : "")}</p>
            {error.startsWith("서버 설정이 변경되었습니다") &&
              <Button variant="outline" size="sm" type="button" onClick={reload}>설정 다시 불러오기</Button>}
          </div>
        )}
      </div>
    </Card>
  );
}
