import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, symlink, link, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSetupStore } from "../src/setup-store.js";
import { buildServer } from "../src/server.js";

const headers = { host: "127.0.0.1:8787", origin: "http://localhost:5173" };
const settings = { kind: "openai-compatible" as const, baseUrl: "https://example.com/v1", model: "test", apiKeyEnv: "", sandboxImage: "localhost/trustgate-target:latest" };
test("credential endpoint persists privately and reports availability without disclosure", async () => {
 const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "trustgate-credential-"));
 const path = join(root, "trustgate", "config.json");
 const store = createSetupStore({configPath:path});
 const app = buildServer({setupStore:store});
 const secret = "synthetic-secret-credential";
 try {
  assert.equal((await app.inject({method:"POST",url:"/api/setup",headers,payload:settings})).statusCode,200);
  const before = await app.inject({method:"GET",url:"/api/setup",headers});
  assert.equal(before.json().settings.keyAvailable,false);
  for (const bad of [{host:"127.0.0.1:8787"},{host:"evil.example",origin:headers.origin},{host:headers.host,origin:"https://evil.example"}]) {
   assert.equal((await app.inject({method:"POST",url:"/api/setup/credential",headers:bad,payload:{secret}})).statusCode,403);
  }
  assert.equal((await app.inject({method:"POST",url:"/api/setup/credential",headers,payload:{secret, extra:true}})).statusCode,400);
  assert.equal((await app.inject({method:"POST",url:"/api/setup/credential",headers,payload:{secret:"bad\nsecret"}})).statusCode,400);
  assert.equal((await app.inject({method:"POST",url:"/api/setup/credential",headers,payload:{secret}})).statusCode,400);
  assert.equal((await app.inject({method:"POST",url:"/api/setup/credential",headers,payload:{secret,kind:settings.kind,baseUrl:"https://other.example/v1"}})).statusCode,409);
  const saved = await app.inject({method:"POST",url:"/api/setup/credential",headers,payload:{secret,kind:settings.kind,baseUrl:settings.baseUrl}});
  assert.equal(saved.statusCode,200); assert.deepEqual(saved.json(),{stored:true});
  assert.equal(saved.headers["cache-control"],"no-store");
  const status = await app.inject({method:"GET",url:"/api/setup",headers});
  assert.equal(status.json().settings.keyAvailable,true);
  assert.ok(!status.body.includes(secret)); assert.ok(!saved.body.includes(secret));
  assert.ok(!JSON.stringify(await store.read()).includes(secret));
  const credentialPath = join(root,"trustgate","credential");
  const credentialRecord = JSON.parse(await readFile(credentialPath,"utf8")) as { secret: string; kind: string; baseUrl: string };
  assert.deepEqual(credentialRecord, { secret, kind: settings.kind, baseUrl: settings.baseUrl });
  assert.equal((await stat(credentialPath)).mode & 0o777,0o600);
  assert.equal((await stat(join(root,"trustgate"))).mode & 0o777,0o700);
  await app.close();
  const reopened = buildServer({setupStore:createSetupStore({configPath:path})});
  try {assert.equal((await reopened.inject({method:"GET",url:"/api/setup",headers})).json().settings.keyAvailable,true);} finally {await reopened.close();}
 } finally { await app.close(); await rm(root,{recursive:true,force:true}); }
});

test("credential store rejects linked targets without modifying them",async()=>{
 const root=await mkdtemp(join(process.env.TMPDIR ?? tmpdir(),"trustgate-credential-link-"));
 try {
  const path=join(root,"trustgate","config.json"); await mkdir(join(root,"trustgate"),{mode:0o700});
  const external=join(root,"outside"); await writeFile(external,"untouched",{mode:0o600});
  const store=createSetupStore({configPath:path});
  await store.save(settings);
  for(const make of [symlink,link]){
   await make(external,join(root,"trustgate","credential"));
   await assert.rejects(store.saveCredential("synthetic-secret", settings));
   await assert.rejects(store.readCredential(settings));
   assert.equal(await readFile(external,"utf8"),"untouched");
   await rm(join(root,"trustgate","credential"));
  }
 } finally {await rm(root,{recursive:true,force:true});}
});

test("changing provider identity never reuses a saved credential", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "trustgate-provider-binding-"));
  const store = createSetupStore({ configPath: join(root, "trustgate", "config.json") });
  const secret = "synthetic-provider-only-credential";
  const receivedAuth: boolean[] = [];
  const provider = createServer((request, response) => {
    receivedAuth.push(request.headers.authorization === `Bearer ${secret}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "pong" }, finish_reason: "stop" }] }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const app = buildServer({ setupStore: store });
  try {
    const first = { ...settings, baseUrl: "https://first.example/v1" };
    const second = { ...settings, baseUrl: `http://127.0.0.1:${address.port}/v1` };
    assert.equal((await app.inject({ method: "POST", url: "/api/setup", headers, payload: first })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/setup/credential", headers, payload: { secret, kind: first.kind, baseUrl: first.baseUrl } })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/setup", headers })).json().settings.keyAvailable, true);
    const sameEndpoint = { ...first, model: "another-model" };
    assert.equal((await app.inject({ method: "POST", url: "/api/setup", headers, payload: sameEndpoint })).json().settings.keyAvailable, true);
    const changed = await app.inject({ method: "POST", url: "/api/setup", headers, payload: second });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().settings.keyAvailable, false);
    assert.equal((await app.inject({ method: "GET", url: "/api/setup", headers })).json().settings.keyAvailable, false);
    assert.equal(await store.readCredential(second), null);
    assert.ok(!changed.body.includes(secret));
    await app.inject({ method: "POST", url: "/api/setup/test", headers, payload: {} });
    assert.deepEqual(receivedAuth, [false]);
    assert.equal((await app.inject({ method: "POST", url: "/api/setup", headers, payload: first })).json().settings.keyAvailable, false);
    assert.equal((await app.inject({ method: "POST", url: "/api/setup", headers, payload: second })).json().settings.keyAvailable, false);
    assert.equal((await app.inject({ method: "POST", url: "/api/setup/credential", headers, payload: { secret, kind: second.kind, baseUrl: second.baseUrl } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/setup/test", headers, payload: {} })).statusCode, 200);
    assert.deepEqual(receivedAuth, [false, true]);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy plaintext credentials require a new save before use", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "trustgate-legacy-credential-"));
  const store = createSetupStore({ configPath: join(root, "trustgate", "config.json") });
  try {
    await store.save(settings);
    await writeFile(join(root, "trustgate", "credential"), "synthetic-legacy-secret", { mode: 0o600 });
    assert.equal(await store.readCredential(settings), null);
    const app = buildServer({ setupStore: store });
    try {
      const result = await app.inject({ method: "GET", url: "/api/setup", headers });
      assert.equal(result.json().settings.keyAvailable, false);
    } finally { await app.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a delayed credential request cannot follow a provider change", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "trustgate-credential-race-"));
  const store = createSetupStore({ configPath: join(root, "trustgate", "config.json") });
  let entered!: () => void;
  let resume!: () => void;
  const enteredSave = new Promise<void>((resolve) => { entered = resolve; });
  const resumeSave = new Promise<void>((resolve) => { resume = resolve; });
  const app = buildServer({ setupStore: {
    ...store,
    saveCredential: async (secret, expected) => {
      entered();
      await resumeSave;
      return store.saveCredential(secret, expected);
    },
  } });
  try {
    const first = { ...settings, baseUrl: "https://first.example/v1" };
    const second = { ...settings, baseUrl: "https://second.example/v1" };
    assert.equal((await app.inject({ method: "POST", url: "/api/setup", headers, payload: first })).statusCode, 200);
    const pending = app.inject({ method: "POST", url: "/api/setup/credential", headers,
      payload: { secret: "synthetic-race-only", kind: first.kind, baseUrl: first.baseUrl } });
    await enteredSave;
    assert.equal((await app.inject({ method: "POST", url: "/api/setup", headers, payload: second })).statusCode, 200);
    resume();
    assert.equal((await pending).statusCode, 409);
    assert.equal((await app.inject({ method: "GET", url: "/api/setup", headers })).json().settings.keyAvailable, false);
    assert.equal(await store.readCredential(second), null);
  } finally {
    resume();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
