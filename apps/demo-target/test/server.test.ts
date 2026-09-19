import assert from "node:assert/strict";
import test from "node:test";
import { buildServer } from "../src/server.js";

test("purchase route exposes deterministic before and after state", async () => {
  const app = buildServer("vulnerable");
  const before = await app.inject({ method: "GET", url: "/__state/alice" });
  const purchase = await app.inject({
    method: "POST",
    url: "/api/purchase",
    headers: { "x-actor-id": "alice" },
    payload: { itemId: "sword", price: -100 },
  });
  const after = await app.inject({ method: "GET", url: "/__state/alice" });
  assert.equal(purchase.statusCode, 200);
  assert.equal(after.json().balance - before.json().balance, 100);
  await app.close();
});
