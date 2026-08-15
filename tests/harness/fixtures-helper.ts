/**
 * Thin wrapper around POST /api/admin/[leagueId]/generate-fixtures.
 *
 * Use the slug (not the UUID) in the URL — getAuthorizedLeagueId resolves
 * both. The endpoint expects the caller to already hold an admin session
 * cookie (superadmin works), and it handles TVT (1 or 2 groups, repetition
 * derived from teamSize + playoffStartGw) and Continental Championship (single PL group,
 * 38 GWs) without further input.
 */

import type { APIRequestContext } from "@playwright/test";

export interface FixtureSummary {
  format: string;
  repetitions?: number;
  leagueStageGws: number;
  totalFixtures: number;
  groupA?: { teams: number; fixtures: number };
  groupB?: { teams: number; fixtures: number };
  plGroup?: { teams: number; fixtures: number };
}

export async function generateFixtures(
  request: APIRequestContext,
  leagueSlugOrId: string,
): Promise<FixtureSummary> {
  const res = await request.post(`/api/admin/${leagueSlugOrId}/generate-fixtures`, {
    failOnStatusCode: false,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) {
    throw new Error(
      `generate-fixtures failed (${res.status()}): ${body?.error ?? JSON.stringify(body)}`,
    );
  }
  return body.summary;
}

export async function deleteFixtures(
  request: APIRequestContext,
  leagueSlugOrId: string,
): Promise<void> {
  const res = await request.delete(`/api/admin/${leagueSlugOrId}/generate-fixtures`, {
    failOnStatusCode: false,
  });
  if (!res.ok()) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`deleteFixtures failed (${res.status()}): ${body?.error ?? ""}`);
  }
}

export async function getFixtureStatus(
  request: APIRequestContext,
  leagueSlugOrId: string,
): Promise<{
  fixturesGenerated: boolean;
  totalFixtures: number;
  readyToGenerate: boolean;
}> {
  const res = await request.get(`/api/admin/${leagueSlugOrId}/generate-fixtures`, {
    failOnStatusCode: false,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) {
    throw new Error(`getFixtureStatus failed (${res.status()}): ${body?.error ?? ""}`);
  }
  return body;
}
