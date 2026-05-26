/**
 * Shared constants for the test harness.
 *
 * Test superadmin matches what scripts/test-reset.ts seeds. The placeholder team
 * login pattern matches what POST /api/superadmin/leagues auto-creates.
 */

export const TEST_SUPERADMIN = {
  email: "test-super@jpl.local",
  password: "testpass1234",
} as const;

/**
 * Auto-created team credentials match the pattern in
 * src/app/api/superadmin/leagues/route.ts:
 *   loginId  = `${slug}Team${i}`         (i = 1..teamSize)
 *   password = `Team@${String(i).padStart(2, "0")}`
 * Teams have `mustChangePassword: true` until they change it.
 */
export function teamLoginId(slug: string, index: number): string {
  return `${slug}Team${index}`;
}

export function teamInitialPassword(index: number): string {
  return `Team@${String(index).padStart(2, "0")}`;
}

/** Password every spec resets teams to after first login (passes the 4-char min). */
export const TEAM_RESET_PASSWORD = "teampass1";
