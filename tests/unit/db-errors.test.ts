/**
 * describeDbError / withDbRetry.
 *
 * The bug this guards: a Drizzle query failure's `.message` is only the SQL plus every bound
 * param, so storing it recorded 50 entrant ids and none of the reason. The reason is on `.cause`.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DrizzleQueryError } from "drizzle-orm";
import { LibsqlError } from "@libsql/client";
import { describeDbError, withDbRetry } from "../../src/lib/db/errors";

const ENTRANT_ID = "0afc4043-4216-41bf-b810-2f9191946d20";
const SELECT_SQL =
  'select "id", "entrant_id", "gw", "created_at" from "fpl_classic_entry_gws" where ("fpl_classic_entry_gws"."gw" = ? and "fpl_classic_entry_gws"."entrant_id" in (?))';

function econnreset(): Error {
  return Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
}

/* ── describeDbError ────────────────────────────────────────────────────── */

test("a Drizzle failure names the statement and the whole cause chain, never the params", () => {
  const fetchFailed = new TypeError("fetch failed", { cause: econnreset() });
  const libsql = new LibsqlError("Server returned HTTP status 502", "SERVER_ERROR", undefined, undefined, fetchFailed);
  const message = describeDbError(new DrizzleQueryError(SELECT_SQL, [7, ENTRANT_ID], libsql));

  assert.equal(
    message,
    "Database error (select from fpl_classic_entry_gws): SERVER_ERROR: Server returned HTTP status 502 → TypeError: fetch failed → read ECONNRESET",
  );
  assert.ok(!message.includes(ENTRANT_ID), "bound params must not leak into the stored message");
  assert.ok(!message.includes("Failed query"), "the SQL text must not be stored");
});

test("insert and update statements are described by verb and table", () => {
  const cause = new LibsqlError("UNIQUE constraint failed", "SQLITE_CONSTRAINT");
  assert.equal(
    describeDbError(new DrizzleQueryError('insert into "fpl_classic_entry_gws" ("id", "updated_at") values (?, ?)', ["x", 1], cause)),
    "Database error (insert into fpl_classic_entry_gws): SQLITE_CONSTRAINT: UNIQUE constraint failed",
  );
  assert.equal(
    describeDbError(new DrizzleQueryError('update "fpl_classic_config" set "last_sync_error" = ? where "league_id" = ?', ["x", "y"], cause)),
    "Database error (update fpl_classic_config): SQLITE_CONSTRAINT: UNIQUE constraint failed",
  );
});

test("a code on a non-libSQL error is prefixed when its message lacks it", () => {
  const undici = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  assert.equal(
    describeDbError(new DrizzleQueryError(SELECT_SQL, [], undici)),
    "Database error (select from fpl_classic_entry_gws): UND_ERR_SOCKET: other side closed",
  );
});

test("the cause chain stops after three levels", () => {
  const deepest = new Error("level 4");
  const chain = new Error("level 1", { cause: new Error("level 2", { cause: new Error("level 3", { cause: deepest }) }) });
  const message = describeDbError(new DrizzleQueryError(SELECT_SQL, [], chain));
  assert.ok(message.endsWith("level 1 → level 2 → level 3"), message);
});

test("a Drizzle failure with no cause says so rather than going blank", () => {
  assert.equal(
    describeDbError(new DrizzleQueryError(SELECT_SQL, [])),
    "Database error (select from fpl_classic_entry_gws): no underlying error was reported",
  );
});

test("anything that is not a Drizzle failure passes through as its message", () => {
  assert.equal(describeDbError(new Error("FPL unavailable: circuit open")), "FPL unavailable: circuit open");
  assert.equal(describeDbError("plain string"), "plain string");
});

test("a very long message is capped", () => {
  const message = describeDbError(new Error("x".repeat(5000)));
  assert.equal(message.length, 400);
  assert.ok(message.endsWith("…"));
});

/* ── withDbRetry ────────────────────────────────────────────────────────── */

test("withDbRetry returns the second attempt's value after one failure", async () => {
  let calls = 0;
  const value = await withDbRetry("test", async () => {
    calls++;
    if (calls === 1) throw new Error("blip");
    return "ok";
  }, { delayMs: 0 });
  assert.equal(value, "ok");
  assert.equal(calls, 2);
});

test("withDbRetry does not retry a success", async () => {
  let calls = 0;
  assert.equal(await withDbRetry("test", async () => { calls++; return 1; }, { delayMs: 0 }), 1);
  assert.equal(calls, 1);
});

test("withDbRetry rethrows the second failure and stops there", async () => {
  let calls = 0;
  await assert.rejects(
    withDbRetry("test", async () => { calls++; throw new Error(`attempt ${calls}`); }, { delayMs: 0 }),
    /attempt 2/,
  );
  assert.equal(calls, 2);
});
