import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../src/store.js";

test("vulnerable purchase trusts a negative client price", () => {
  const store = createStore("vulnerable");
  const before = store.snapshot("alice");
  const response = store.purchase("alice", { itemId: "sword", price: -100 });
  const after = store.snapshot("alice");
  assert.equal(response.status, 200);
  assert.equal(after.balance - before.balance, 100);
});

test("patched purchase uses the server price and rejects mismatch", () => {
  const store = createStore("patched");
  const before = store.snapshot("alice");
  const response = store.purchase("alice", { itemId: "sword", price: -100 });
  const after = store.snapshot("alice");
  assert.equal(response.status, 400);
  assert.equal(after.balance, before.balance);
});

test("patched transfer rejects an item not owned by the actor", () => {
  const store = createStore("patched");
  const response = store.transfer("bob", { itemId: "alice-shield", toUserId: "bob" });
  assert.equal(response.status, 403);
  assert.equal(store.ownerOf("alice-shield"), "alice");
});

test("vulnerable transfer of the seeded foreign item moves it and grows alice's inventory", () => {
  const store = createStore("vulnerable");
  const before = store.snapshot("alice");
  const response = store.transfer("alice", { itemId: "relic", toUserId: "alice" });
  const after = store.snapshot("alice");
  assert.equal(response.status, 200);
  assert.equal(after.inventoryCount - before.inventoryCount, 1);
  assert.equal(store.ownerOf("relic"), "alice");
});

test("patched transfer rejects the foreign item seeded to bob", () => {
  const store = createStore("patched");
  const before = store.snapshot("alice");
  const response = store.transfer("alice", { itemId: "relic", toUserId: "alice" });
  const after = store.snapshot("alice");
  assert.equal(response.status, 403);
  assert.equal(after.inventoryCount, before.inventoryCount);
  assert.equal(store.ownerOf("relic"), "bob");
});
