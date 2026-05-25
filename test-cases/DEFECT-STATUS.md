# Defect Backlog Status — 2026-05-25

Snapshot of the JPL-Leagues defect backlog after the first round of senior-developer fixes. Full per-defect detail lives in [`sources/*.json`](sources/) under each module's `defects` array, and the consolidated view is in the **Defects** sheet of [`jpl-leagues-test-cases.xlsx`](jpl-leagues-test-cases.xlsx).

## Headline numbers

| | Critical | Major | Minor | Cosmetic | **Total** |
|---|---:|---:|---:|---:|---:|
| Catalogued | 6 | 44 | 29 | 1 | **80** |
| Fixed | 5 | 0 | 0 | 0 | **5** |
| Wont Fix | 1 | 0 | 0 | 0 | **1** |
| **Still Open** | **0** | **44** | **29** | **1** | **74** |

All 6 **Critical** defects have been dispositioned. Remaining work is **44 Major + 29 Minor + 1 Cosmetic**.

## What got done (this round)

The senior-developer / qa-tester / business-analyst loop ran end-to-end on every Critical defect. Code fixes were verified against `npx tsc --noEmit`; for each Fixed defect the regression test case was inverted from `Regression` to `Positive` and the underlying business rule / acceptance criterion text was rewritten to describe the new behaviour. `requirements.version` was bumped on every touched module.

| Defect | Module | Disposition | Code change |
|---|---|---|---|
| DEF-LEAGUE-001 | League Setup | **Wont Fix** | None — investigation showed the BA misread the format. TVT-8 with `playoffStartGw=36` actually gives 3 playoff GWs (SF at GW36, Final + 3rd-place as 2-leg ties at GW37+38). BR-LEAGUE-008 rewritten to describe the actual behaviour. |
| DEF-04-001 | Team Self-Service | **Fixed** | `src/app/api/team/setup/route.ts:159-187` — purse initialisation now gated on `!team.isProfileComplete`. Re-submitting the setup wizard preserves `purse`, `totalSpent`, `totalRefunds`, `totalIncome`; only cosmetic fields update. |
| DEF-PLAYOFF-003 | TVT Playoffs | **Fixed** | `src/lib/backup/restore-tvt.ts:128-135` — wipe phase now also deletes `playoffTies` (by `leagueId`) and `challengerSurvivalEntries` (by league `gameweekIds`) before re-inserting restored fixtures. |
| DEF-BACKUP-004 | Backups & Restore | **Fixed** | `src/app/api/admin/[leagueId]/restore-auction/route.ts:355-579` — entire wipe + restore block wrapped in `db.transaction(async (tx) => {...})`. All 12 deletes + 9 inserts + 2 updates now atomic. |
| DEF-CHIP-006 | Captains & Chips | **Fixed** | `src/app/api/admin/[leagueId]/import-chips/route.ts:360-401` — DELETE now league-scoped on both per-GW and bulk branches; team set-used flag reset extended from 6 → 12 columns (now covers Score Lock / Comeback / Underdog × Set1+Set2). |
| DEF-SUPER-006 | Superadmin | **Fixed** | `src/app/api/superadmin/score-adjustments/route.ts:130-184` — PATCH now re-ranks the full GW + recomputes payouts via `getPayoutForRank` + adjusts `teams.purse` and `teams.totalIncome` by the payout delta, all inside one transaction. |

## Process validation

The multi-agent workflow caught **DEF-LEAGUE-001** as a misread before any wrong "fix" got applied. The senior-developer:
1. Read the cited source files.
2. Discovered that `advanceSF8` in `advance-playoffs/route.ts:805-841` builds `8T-FINAL` and `8T-3RD` as 2-leg ties at `playoffStartGw+1` / `+2`.
3. Cross-checked `fixtures.ts:106` (`isPlayoffs` covers `[playoffStartGw, 38]`) and `playoffs.ts:264` (`ensurePlayoffGws` auto-creates GW rows).
4. Set `status: Triage` with a `[DEV-QUESTION]` for the BA instead of guessing.
5. The BA agent then verified the dev's finding against the same source files, dispositioned as `Wont Fix`, and rewrote BR-LEAGUE-008 to describe the actual (correct) behaviour.

This is the exact safety the BA↔Dev↔QA loop is meant to provide. The artefact trail (`[DEV-QUESTION]`, `[BA-DISPOSITION]`, resolution text, sourceRefs to verifying code) lets a future reader reconstruct the decision.

## Remaining work, prioritised for triage

### Most user-visible Major defects (likely top of the list)

These are likely to bite real users in production:

| Defect | Module | Why it matters |
|---|---|---|
| DEF-ECON-001 | Auction Economy | `GET /api/auction/economy` leaks any team's full economy/income history to any authenticated session. Cross-team data exposure. |
| DEF-TRADE-003 | Auction Marketplace | `/api/auction/release` is not blocked during a live auction session — a team can dump players mid-draft. |
| DEF-TRADE-004 | Auction Marketplace | `auction-corrections` adjusts `totalSpent` but never touches `teams.purse` → purse drifts away from the ledger over time. |
| DEF-SUPER-003 | Superadmin | `PATCH /superadmin/admins/[userId]` can mutate another superadmin's credentials with no guard. |
| DEF-CHIP-001 / DEF-CHIP-004 | Captains & Chips | Gameweek lookups not scoped to `leagueId` — chip operations can cross-pollinate between leagues. |
| DEF-GWFIX-005 | Gameweeks & Fixtures | `POST /api/gameweeks/[gw]` without `leagueId` falls through to a TVT default and can score the wrong league. |
| DEF-BACKUP-001 | Backups & Restore | `DELETE /api/admin/[leagueId]/backups/[backupId]` handler is missing — admins can't delete backups via the API. |
| DEF-BACKUP-003 | Backups & Restore | `restoreFixtures` wipes existing fixtures even when the payload's fixtures array is empty (data-loss risk). |
| DEF-TC-003 | Triple Crown | Triple Crown restore omits cup fixtures + UCL/UEL knockouts — restored leagues lose their cup competitions. |
| DEF-PLAYOFF-004 | TVT Playoffs | TVT-16 tentative bracket renders an 8-team single-elimination tree instead of the 4-group playoff stage. |
| DEF-PLAYOFF-001 | TVT Playoffs | C-31 seeding pattern diverges between `generate-playoffs` and the public bracket projection — admin and public see different brackets. |
| DEF-AUTH-001 | Auth | Change-password client allows 6-char passwords while the API enforces 8 + digit/special — confusing UX on a security-sensitive form. |
| DEF-TEAM-003 | Team Management | `delete-team` has no guard against deleting Triple Crown bye-placeholder ghost teams — admin deletion can break the cup schedule. |
| DEF-PUB-001 | Public Pages | `/rules` redirects anonymous visitors to `/signin` despite being intended as public — bounce risk for marketing/onboarding flows. |

### Full Major defect list by module

44 Major defects open. Group by module to plan a per-module sweep:

- **Auction Core** (1): `DEF-AUC-001`
- **Auction Economy** (2): `DEF-ECON-001`, `DEF-ECON-002`
- **Auction Marketplace** (3): `DEF-TRADE-002`, `DEF-TRADE-003`, `DEF-TRADE-004`
- **Auction Slots & Club** (2): `DEF-SLOTS-001`, `DEF-SLOTS-002`
- **Auth** (1): `DEF-AUTH-001`
- **Backups & Restore** (3): `DEF-BACKUP-001`, `DEF-BACKUP-002`, `DEF-BACKUP-003`
- **Captains & Chips** (6): `DEF-CHIP-001` … `DEF-CHIP-005`, `DEF-CHIP-007`
- **Gameweeks & Fixtures** (5): `DEF-GWFIX-001` … `DEF-GWFIX-005`
- **League Setup** (1): `DEF-LEAGUE-002`
- **Public Pages** (1): `DEF-PUB-001`
- **Standings & Results** (3): `DEF-STAND-001`, `DEF-STAND-003`, `DEF-STAND-004`
- **Superadmin** (4): `DEF-SUPER-001`, `DEF-SUPER-003`, `DEF-SUPER-005`, `DEF-SUPER-007`
- **TVT Playoffs** (3): `DEF-PLAYOFF-001`, `DEF-PLAYOFF-002`, `DEF-PLAYOFF-004`
- **Team Management** (4): `DEF-TEAM-001`, `DEF-TEAM-002`, `DEF-TEAM-003`, `DEF-TEAM-005`
- **Team Self-Service** (2): `DEF-04-002`, `DEF-04-003`
- **Triple Crown** (3): `DEF-TC-001`, `DEF-TC-002`, `DEF-TC-003`

### Minor + Cosmetic

- **29 Minor** — mostly comment-vs-code drift, dead code, validation polish, error-message UX. See per-module Defects sheets for detail.
- **1 Cosmetic** — `DEF-TC-006` (sort comment in `triple-crown/standings.ts` says GA ASC, code uses GD then GF).

## How to resume the fix loop

Two ways:

**1. Per-defect, with the multi-agent loop (slowest, highest assurance):**
```
For each defect XXX-NNN:
  1. Invoke senior-developer with the defect ID + scope notes.
  2. Once dev reports Fixed:
     a. Invoke qa-tester in fix-verification mode for the same defect.
     b. Invoke business-analyst in post-fix update mode for the same defect.
  3. npm run test-cases:build
```
Wired up via the three agent specs:
- [.claude/agents/senior-developer.md](../.claude/agents/senior-developer.md)
- [.claude/agents/qa-tester.md](../.claude/agents/qa-tester.md) (fix-verification mode section)
- [.claude/agents/business-analyst.md](../.claude/agents/business-analyst.md) (post-fix update mode section)

**2. Engineer-driven (faster, less self-checking):**
- Read the defect entry in the relevant `sources/*.json`.
- Apply the fix manually in the relevant `src/` files.
- Update the defect entry's `status`, `resolution`, `resolutionDate`, `notes`.
- Have QA (or yourself) flip the regression TC from `Regression` to `Positive` and update its `expectedResult`.
- Update the linked BR / AC text.
- `npm run test-cases:build`.

## File pointers

- All defect bodies (descriptions, expected vs actual behaviour, source line refs, linked BR/AC/TC IDs, dev/qa/ba notes audit trail): `test-cases/sources/<NN>-<module>.json` → `defects` array.
- Consolidated view: `test-cases/jpl-leagues-test-cases.xlsx` → `Defects` sheet (sorted Critical → Cosmetic, Open before Closed).
- Per-module test-case sheets: same workbook, one tab per module.
- Traceability Matrix tab: every requirement ↔ test case ↔ defect link.

## Glossary

- **`pinningTestCases`**: TC IDs that lock in the *defective* current behaviour. After a fix, the QA agent inverts them from `Regression` → `Positive` and updates `expectedResult` to reflect the new correct behaviour.
- **`linkedBusinessRules` / `linkedAcceptanceCriteria`**: the BR / AC entries that describe the defective behaviour. After a fix, the BA agent rewrites these to describe the new correct behaviour.
- **`[DEV-QUESTION]` in `notes`**: senior-developer needs BA clarification before fixing.
- **`[DEV] Self-verified`**: senior-developer ran `npx tsc --noEmit` and reviewed the diff.
- **`[QA-VERIFIED]`**: qa-tester confirmed the fix against the regression tests.
- **`[BA-UPDATED]`**: business-analyst rewrote the relevant BR / AC text post-fix.
- **`[BA-DISPOSITION]`**: business-analyst formally closed the defect (typically `Wont Fix` or `Accepted`).
