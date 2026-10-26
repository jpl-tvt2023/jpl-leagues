/**
 * Turning database failures into something a person can act on.
 *
 * Drizzle wraps every driver failure in a DrizzleQueryError whose `.message` is the full SQL plus
 * every bound param — and nothing else. The libSQL error that actually explains the failure (a
 * Turso 5xx, `fetch failed`, a constraint) lives only on `.cause`. Storing `.message` therefore
 * records the one part that is never the problem, and copies row ids into wherever it is shown.
 *
 * No import of "@/lib/db" here: this module must stay loadable by the unit tests without a client.
 */

import { DrizzleQueryError } from "drizzle-orm";

const MAX_LENGTH = 400;
const MAX_CAUSE_DEPTH = 3;
const RETRY_DELAY_MS = 750;

function cap(text: string): string {
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text;
}

/** "select from fpl_classic_entry_gws", "insert into …" — the statement's shape, never its params. */
function statementShape(query: string): string {
  const verb = query.trim().match(/^(select|insert into|update|delete from)\b/i)?.[1]?.toLowerCase();
  const table = query.match(/\b(?:from|into|update)\s+["`]?([\w.]+)/i)?.[1];
  if (!verb || !table) return "query";
  return verb === "select" ? `select from ${table}` : `${verb} ${table}`;
}

/**
 * One cause per level, outermost first: `SERVER_ERROR: … → TypeError: fetch failed → read ECONNRESET`.
 * A LibsqlError already prefixes its code onto its message; anything else with a `code` (Node
 * system errors, undici) gets it added, and a code-less error is labelled by its class instead.
 */
function describeCauseChain(cause: unknown): string {
  const parts: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code) {
      parts.push(current.message.includes(code) ? current.message : `${code}: ${current.message}`);
    } else {
      parts.push(current.name && current.name !== "Error" ? `${current.name}: ${current.message}` : current.message);
    }
    current = current.cause;
  }
  return parts.join(" → ");
}

/**
 * A short, param-free description of any error, safe to store and show. For a Drizzle query
 * failure that is the statement's shape plus the underlying cause chain; anything else is its
 * message as-is.
 */
export function describeDbError(err: unknown): string {
  if (err instanceof DrizzleQueryError) {
    const cause = err.cause === undefined ? "no underlying error was reported" : describeCauseChain(err.cause);
    return cap(`Database error (${statementShape(err.query)}): ${cause}`);
  }
  return cap(err instanceof Error ? err.message : String(err));
}

/**
 * Run `fn` and, if it throws, run it once more after a short pause. ONLY for idempotent work —
 * reads, `onConflictDoNothing`, an upsert to the same values, a forward-only cursor — because a
 * failure is no proof the first attempt did not commit.
 */
export async function withDbRetry<T>(label: string, fn: () => PromiseLike<T>, opts?: { delayMs?: number }): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[db] retrying ${label}:`, describeDbError(err));
    await new Promise((resolve) => setTimeout(resolve, opts?.delayMs ?? RETRY_DELAY_MS));
    return await fn();
  }
}
