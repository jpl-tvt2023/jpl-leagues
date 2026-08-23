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
 * Auto-created team credentials must match the pattern in
 * src/app/api/superadmin/leagues/route.ts (see the team-creation loop):
 *   loginId  = `${slug}-Team${i}`        (i = 1..teamSize)
 *   password = `Team${i}`
 * Teams have `mustChangePassword: true` until they change it.
 *
 * These drifted once already — the route grew a hyphen and dropped the
 * zero-padded `Team@01` password while these constants kept the old shape,
 * which failed every spec at setup with "Invalid credentials". If sign-in
 * starts failing in setupTvtTeam, check this pair first.
 */
export function teamLoginId(slug: string, index: number): string {
  return `${slug}-Team${index}`;
}

export function teamInitialPassword(index: number): string {
  return `Team${index}`;
}

/** Password every spec resets teams to after first login (passes the 4-char min). */
export const TEAM_RESET_PASSWORD = "teampass1";
