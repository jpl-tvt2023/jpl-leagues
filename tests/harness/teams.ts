/**
 * Team-level harness: bypasses the first-login password-change wall and the
 * /setup wizard so specs can jump straight into captain/chip/auction flows.
 *
 * After league creation, every team carries `mustChangePassword: true` and
 * `isProfileComplete: false`. Without this helper, every spec would have to
 * drive both walls per team — slow and noisy.
 */

import type { APIRequestContext } from "@playwright/test";
import { teamLoginId, teamInitialPassword, TEAM_RESET_PASSWORD } from "./constants";
import { apiSignIn, apiSignOut } from "./auth";

export interface TeamHandle {
  index: number;
  loginId: string;
  password: string;
  /** Team display name after setup (`Team N` if no override). */
  name: string;
}

/**
 * For a TVT or Triple Crown team: change the password and complete the
 * /setup wizard with deterministic FPL IDs.
 *
 * `fplBase` is the starting FPL element ID; team i gets (fplBase + 2i, fplBase + 2i + 1)
 * so every team in a league has a unique pair without colliding across teams.
 */
export async function setupTvtTeam(
  request: APIRequestContext,
  slug: string,
  index: number,
  opts: { teamName?: string; fplBase?: number } = {},
): Promise<TeamHandle> {
  const loginId = teamLoginId(slug, index);
  const teamName = opts.teamName ?? `Team ${index}`;
  const fplBase = opts.fplBase ?? 1000;

  // First sign-in: forces password change
  const signIn = await apiSignIn(request, loginId, teamInitialPassword(index));
  if (!signIn.ok) throw new Error(`setupTvtTeam: signIn failed for ${loginId}: ${signIn.error}`);

  // Change password
  const cp = await request.post("/api/auth/change-password", {
    data: { currentPassword: teamInitialPassword(index), newPassword: TEAM_RESET_PASSWORD },
    failOnStatusCode: false,
  });
  if (!cp.ok()) {
    const body = await cp.json().catch(() => ({}));
    throw new Error(`setupTvtTeam: change-password failed: ${cp.status()} ${body?.error ?? ""}`);
  }

  // Complete setup wizard
  const setup = await request.post("/api/team/setup", {
    data: {
      teamLoginId: loginId,
      teamName,
      player1Name: `${teamName} P1`,
      player1FplId: String(fplBase + index * 2),
      player2Name: `${teamName} P2`,
      player2FplId: String(fplBase + index * 2 + 1),
    },
    failOnStatusCode: false,
  });
  if (!setup.ok()) {
    const body = await setup.json().catch(() => ({}));
    throw new Error(`setupTvtTeam: setup failed: ${setup.status()} ${body?.error ?? ""}`);
  }

  await apiSignOut(request);
  return { index, loginId, password: TEAM_RESET_PASSWORD, name: teamName };
}

/**
 * Auction-league team setup. Same as TVT but the setup endpoint skips the FPL
 * IDs (auction leagues don't have player rows — squads come from bidding).
 */
export async function setupAuctionTeam(
  request: APIRequestContext,
  slug: string,
  index: number,
  opts: { teamName?: string } = {},
): Promise<TeamHandle> {
  const loginId = teamLoginId(slug, index);
  const teamName = opts.teamName ?? `Team ${index}`;

  const signIn = await apiSignIn(request, loginId, teamInitialPassword(index));
  if (!signIn.ok) throw new Error(`setupAuctionTeam: signIn failed for ${loginId}: ${signIn.error}`);

  const cp = await request.post("/api/auth/change-password", {
    data: { currentPassword: teamInitialPassword(index), newPassword: TEAM_RESET_PASSWORD },
    failOnStatusCode: false,
  });
  if (!cp.ok()) {
    const body = await cp.json().catch(() => ({}));
    throw new Error(`setupAuctionTeam: change-password failed: ${cp.status()} ${body?.error ?? ""}`);
  }

  const setup = await request.post("/api/team/setup", {
    data: {
      teamLoginId: loginId,
      teamName,
      // Auction setup ignores player fields; pass empty strings to match real client.
      player1Name: "",
      player1FplId: "",
      player2Name: "",
      player2FplId: "",
    },
    failOnStatusCode: false,
  });
  if (!setup.ok()) {
    const body = await setup.json().catch(() => ({}));
    throw new Error(`setupAuctionTeam: setup failed: ${setup.status()} ${body?.error ?? ""}`);
  }

  await apiSignOut(request);
  return { index, loginId, password: TEAM_RESET_PASSWORD, name: teamName };
}

/** Set up every team in a league sequentially. Returns ordered handles. */
export async function setupAllTeams(
  request: APIRequestContext,
  slug: string,
  count: number,
  format: "tvt" | "triple-crown" | "auction",
  opts: { fplBase?: number } = {},
): Promise<TeamHandle[]> {
  const setup = format === "auction" ? setupAuctionTeam : setupTvtTeam;
  const handles: TeamHandle[] = [];
  for (let i = 1; i <= count; i++) {
    handles.push(await setup(request, slug, i, { fplBase: opts.fplBase }));
  }
  return handles;
}
