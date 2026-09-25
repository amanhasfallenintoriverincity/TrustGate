import { createServer } from "node:http";
import { expect, test } from "@playwright/test";

/** Both web servers must use the isolated XDG_CONFIG_HOME from playwright.config.ts. */
test("설정 상태를 실제 로컬 API에서 읽고 단계 화면을 유지한다", async ({ page }) => {
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/setup") && response.request().method() === "GET");
  await page.goto("/#/setup");
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const status: unknown = await response.json();
  expect(status).toEqual(expect.objectContaining({ mode: "fixture", configured: expect.any(Boolean) }));
  if (typeof status === "object" && status !== null && "configured" in status && status.configured) {
    await expect(page.getByRole("heading", { name: "연결 설정" })).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { name: "첫 실행 설정" })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "샘플 분석 실행", exact: true })).toHaveCount(0);
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "결과 확인" }).click();
  await expect(page.getByRole("region", { name: "요약 지표" }).locator(".section-head > span")).toContainText("분석 결과 없음");
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "연결 설정" }).click();
  await expect(page.getByRole("button", { name: "프로젝트 분석", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "설정 바로가기" }).getByRole("button", { name: "설정" })).toBeVisible();
  await page.getByRole("button", { name: "설정 접기" }).click();
  await expect(page.getByRole("button", { name: "설정 펼치기" })).toBeVisible();
  await page.getByRole("region", { name: "설정 바로가기" }).getByRole("button", { name: "설정" }).click();
  await expect(page.getByRole("button", { name: "설정 접기" })).toBeVisible();
  await expect(page.getByLabel("제공자 종류")).toHaveValue(status && typeof status === "object" && "settings" in status &&
    status.settings && typeof status.settings === "object" && "kind" in status.settings ? String(status.settings.kind) : "openai-compatible");
  await expect(page.getByLabel("API 인증 정보")).toHaveAttribute("type", "password");
});

test("360px 첫 실행 폼은 잘리지 않고 가로 스크롤도 없다", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/setup") && response.request().method() === "GET");
  await page.goto("/#/setup");
  expect((await responsePromise).status()).toBe(200);
  await expect(page.getByLabel("샌드박스 이미지")).toBeVisible();
  await expect(page.getByRole("button", { name: "설정 저장" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(dimensions.scroll - dimensions.client).toBe(0);
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "결과 확인" }).click();
  await expect(page.getByRole("region", { name: "요약 지표" })).toBeVisible();
});

test("첫 실행 설정을 실제 프록시로 저장하고 로컬 제공자 연결을 확인한다", async ({ page, request }) => {
  // Fail before any browser write if this spec is run without the isolated E2E harness.
  expect(process.env.TRUSTGATE_E2E_ISOLATED).toBe("1");
  // Only a disposable loopback listener can receive the connection test. Record booleans,
  // not headers or raw request bodies, so a failed assertion cannot print a credential.
  const calls: Array<{ correctPath: boolean; post: boolean; authenticated: boolean; validBody: boolean }> = [];
  const provider = createServer(async (incoming, outgoing) => {
    let body = "";
    for await (const chunk of incoming) body += chunk.toString();
    let validBody = false;
    try {
      const payload: unknown = JSON.parse(body);
      validBody = typeof payload === "object" && payload !== null &&
        "model" in payload && payload.model === "e2e-local-model" &&
        "max_tokens" in payload && payload.max_tokens === 8 &&
        "stream" in payload && payload.stream === false &&
        "messages" in payload && JSON.stringify(payload.messages) === JSON.stringify([{ role: "user", content: "ping" }]);
    } catch { /* A malformed request must fail the assertion, not crash the fake server. */ }
    calls.push({
      correctPath: incoming.url === "/v1/chat/completions", post: incoming.method === "POST",
      authenticated: incoming.headers.authorization !== undefined || incoming.headers["x-api-key"] !== undefined,
      validBody,
    });
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ choices: [{ message: { content: "pong" }, finish_reason: "stop" }] }));
  });
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = provider.address();
    if (address === null || typeof address === "string") throw new Error("loopback provider did not listen");
    const settings = {
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "e2e-local-model",
      apiKeyEnv: "",
      sandboxImage: "localhost/trustgate-target:latest",
    };

    const discovery = page.waitForResponse((response) =>
      response.url().endsWith("/api/setup") && response.request().method() === "GET");
    await page.goto("/#/setup");
    const initial = await discovery;
    expect(initial.status()).toBe(200);
    const initialStatus: unknown = await initial.json();
    expect(JSON.stringify(initialStatus) === JSON.stringify({ mode: "fixture", configured: false, settings: null })).toBe(true);
    await expect(page.getByRole("heading", { name: "첫 실행 설정", exact: true })).toBeVisible();
    await expect(page.getByLabel("API 인증 정보")).toHaveAttribute("type", "password");
    await page.getByLabel("기본 URL").fill(settings.baseUrl);
    await page.getByLabel("모델").fill(settings.model);
    await page.getByLabel("샌드박스 이미지").fill(settings.sandboxImage);
    await expect(page.getByLabel("API 인증 정보")).toHaveValue("");
    await expect(page.getByRole("button", { name: "연결 테스트", exact: true })).toBeDisabled();

    const save = page.waitForResponse((response) =>
      response.url().endsWith("/api/setup") && response.request().method() === "POST");
    await page.getByRole("button", { name: "설정 저장", exact: true }).click();
    const saved = await save;
    expect(saved.status()).toBe(200);
    const sent: unknown = saved.request().postDataJSON();
    expect(JSON.stringify(sent) === JSON.stringify(settings)).toBe(true); // Never print a bad body if it contained a secret.
    expect(calls).toHaveLength(0); // Saving must not silently contact a provider.
    await expect(page.locator("#setup-title")).toHaveText("연결 설정");
    await expect(page.getByText(/인증 정보: 저장되지 않음/)).toBeVisible();
    await expect(page.getByRole("button", { name: "연결 테스트", exact: true })).toBeEnabled();

    // Save a synthetic credential in the isolated E2E store, never a real account key.
    const syntheticCredential = "e2e-synthetic-credential";
    await page.getByLabel("API 인증 정보").fill(syntheticCredential);
    const credentialSave = page.waitForResponse((response) =>
      response.url().endsWith("/api/setup/credential") && response.request().method() === "POST");
    await page.getByRole("button", { name: "인증 정보 저장", exact: true }).click();
    const stored = await credentialSave;
    expect(stored.status()).toBe(200);
    const credentialRequest: unknown = stored.request().postDataJSON();
    expect(JSON.stringify(credentialRequest) === JSON.stringify({
      secret: syntheticCredential, kind: settings.kind, baseUrl: settings.baseUrl,
    })).toBe(true);
    await expect(page.getByLabel("API 인증 정보")).toHaveValue("");
    await expect(page.getByText(/인증 정보: 서버 저장소에 저장됨/)).toBeVisible();

    const persisted = await request.get("/api/setup"); // GET through Vite, not an in-memory UI copy.
    expect(persisted.status()).toBe(200);
    const persistedStatus: unknown = await persisted.json();
    expect(JSON.stringify(persistedStatus) === JSON.stringify({
      mode: "fixture", configured: true, settings: { ...settings, keyAvailable: true },
    })).toBe(true);
    expect(JSON.stringify(persistedStatus).includes(syntheticCredential)).toBe(false);
    await page.reload();
    await expect(page.locator("#setup-title")).toHaveText("연결 설정");
    await expect(page.getByLabel("기본 URL")).toHaveValue(settings.baseUrl);
    await expect(page.getByLabel("모델")).toHaveValue(settings.model);
    await expect(page.getByLabel("API 인증 정보")).toHaveValue("");
    await expect(page.getByLabel("API 인증 정보")).toHaveAttribute("type", "password");

    const connection = page.waitForResponse((response) =>
      response.url().endsWith("/api/setup/test") && response.request().method() === "POST");
    await page.getByRole("button", { name: "연결 테스트", exact: true }).click();
    const connected = await connection;
    expect(connected.status()).toBe(200);
    // Browser consumes this small fetch response immediately; the rendered success plus the
    // captured provider request is stronger evidence than a racy CDP Network.getResponseBody.
    await expect(page.locator(".setup-message")).toHaveText("연결 테스트 성공");
    expect(calls).toEqual([{
      correctPath: true, post: true, authenticated: true, validBody: true,
    }]);

    expect(calls).toHaveLength(1);
    await expect(page.getByRole("button", { name: "샘플 분석 실행", exact: true })).toHaveCount(0);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});
