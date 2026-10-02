/**
 * Multi-account cookie helpers (src/lib/auth-accounts.ts).
 *
 * The accounts cookie is what lets one device hold several signed-in accounts and switch between
 * them. These tests pin the properties that make that safe: entries must be real signed tokens,
 * expired or tampered ones disappear, one account never appears twice, and the list is capped.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";

// `createSession`/`verifySession` read the secret lazily, at call time.
process.env.SESSION_SECRET ??= "unit-test-secret-that-is-at-least-32-characters";

import { createSession } from "../../src/lib/auth";
import {
  MAX_ACCOUNTS,
  accountKey,
  decodeAccounts,
  encodeAccounts,
  readAccounts,
  removeAccount,
  upsertAccount,
} from "../../src/lib/auth-accounts";

const keysOf = async (tokens: string[]) => (await readAccounts(encodeAccounts(tokens))).map((a) => a.key);

test("encode/decode round-trips a token list", () => {
  assert.deepEqual(decodeAccounts(encodeAccounts(["a.b", "c.d"])), ["a.b", "c.d"]);
});

test("garbage cookie values read as an empty list instead of throwing", () => {
  for (const raw of [undefined, null, "", "not-base64!!", encodeAccounts([]), Buffer.from("{}").toString("base64url")]) {
    assert.deepEqual(decodeAccounts(raw), []);
  }
});

test("signing in puts the account first and keeps the others", async () => {
  const team1 = await createSession("t1", "team");
  const team2 = await createSession("t2", "team");
  const one = await upsertAccount(undefined, team1);
  const both = await upsertAccount(encodeAccounts(one), team2);
  assert.deepEqual(await keysOf(both), ["team:t2", "team:t1"]);
});

test("signing in again replaces that account's old token rather than listing it twice", async () => {
  const first = await createSession("t1", "team");
  const other = await createSession("a1", "admin");
  const again = await createSession("t1", "team");
  let list = await upsertAccount(undefined, first);
  list = await upsertAccount(encodeAccounts(list), other);
  list = await upsertAccount(encodeAccounts(list), again);
  assert.deepEqual(await keysOf(list), ["team:t1", "admin:a1"]);
  assert.equal(list[0], again, "the newest token is the one kept");
});

test("the same id under a different role is a different account", async () => {
  const asTeam = await createSession("x", "team");
  const asAdmin = await createSession("x", "admin");
  const list = await upsertAccount(encodeAccounts(await upsertAccount(undefined, asTeam)), asAdmin);
  assert.deepEqual(await keysOf(list), ["admin:x", "team:x"]);
});

test(`the list is capped at ${MAX_ACCOUNTS}, evicting the least recently used`, async () => {
  let list: string[] = [];
  for (let i = 1; i <= MAX_ACCOUNTS + 2; i++) {
    list = await upsertAccount(encodeAccounts(list), await createSession(`t${i}`, "team"));
  }
  const keys = await keysOf(list);
  assert.equal(keys.length, MAX_ACCOUNTS);
  assert.equal(keys[0], `team:t${MAX_ACCOUNTS + 2}`);
  assert.ok(!keys.includes("team:t1") && !keys.includes("team:t2"), "the two oldest were evicted");
});

test("a tampered token is dropped on read", async () => {
  const good = await createSession("t1", "team");
  const [payload, sig] = good.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ id: "victim", type: "superadmin", exp: 9999999999 })).toString("base64url");
  const forged = `${forgedPayload}.${sig}`;
  const flipped = `${payload}.${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`;
  assert.deepEqual(await keysOf([forged, flipped, good]), ["team:t1"]);
});

test("an invalid token is never added", async () => {
  const good = await createSession("t1", "team");
  const list = await upsertAccount(encodeAccounts([good]), "nonsense.token");
  assert.deepEqual(await keysOf(list), ["team:t1"]);
});

test("an expired token is dropped on read", async () => {
  const realNow = Date.now;
  let stale: string;
  try {
    Date.now = () => realNow() - 8 * 24 * 60 * 60 * 1000; // minted 8 days ago; sessions last 7
    stale = await createSession("old", "team");
  } finally {
    Date.now = realNow;
  }
  const fresh = await createSession("new", "team");
  assert.deepEqual(await keysOf([stale, fresh]), ["team:new"]);
});

test("removing an account leaves the rest in order", async () => {
  const a = await createSession("a", "team");
  const b = await createSession("b", "team");
  const c = await createSession("c", "admin");
  const list = await removeAccount(encodeAccounts([a, b, c]), accountKey({ id: "b", type: "team" }));
  assert.deepEqual(await keysOf(list), ["team:a", "admin:c"]);
});
