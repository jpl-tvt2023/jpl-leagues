# JPL-Leagues — Full Repository Context

## Overview
A full-stack Fantasy Premier League (FPL) tournament management system called **JPL TVT** (Two vs Two). Two FPL managers form one team; teams compete head-to-head across a league stage then playoffs. Built with Next.js 16, Drizzle ORM, Turso (LibSQL), and Upstash Redis.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 (strict) |
| Database | Turso (LibSQL / SQLite) via Drizzle ORM |
| Cache | Upstash Redis |
| Styling | Tailwind CSS v4 |
| Password hashing | bcryptjs |
| Excel import | xlsx |
| Deployment | Vercel (with Cron Jobs) |

Path alias: `@/*` → `./src/*`

---

## Environment Variables

```
UPSTASH_REDIS_REST_URL      # Upstash Redis endpoint
UPSTASH_REDIS_REST_TOKEN    # Upstash Redis auth
TURSO_AUTH_TOKEN            # Turso DB auth token
TURSO_CONNECTION_URL        # libsql://... Turso DB URL
SESSION_SECRET              # HMAC key for session signing (min 32 chars)
CRON_SECRET                 # Bearer token for Vercel Cron endpoints (optional)
```

---

## Directory Structure

```
src/
├── app/
│   ├── page.tsx                        # Home (league browsing)
│   ├── layout.tsx                      # Root layout
│   ├── signin/page.tsx
│   ├── change-password/page.tsx
│   ├── dashboard/page.tsx              # Team dashboard
│   ├── standings/page.tsx              # Global standings view
│   ├── fixtures/page.tsx               # Global fixtures (supports ?adminLeague=slug)
│   ├── playoffs/page.tsx               # Global playoffs (supports ?adminLeague=slug)
│   ├── rules/page.tsx
│   ├── [leagueSlug]/
│   │   ├── fixtures/page.tsx           # League public fixtures
│   │   ├── standings/page.tsx          # League public standings
│   │   ├── playoffs/page.tsx           # League public playoffs
│   │   ├── rules/page.tsx
│   │   └── help/page.tsx
│   ├── admin/
│   │   ├── page.tsx                    # Admin league selection
│   │   └── [leagueId]/
│   │       ├── page.tsx                # League admin dashboard
│   │       └── help/page.tsx
│   ├── superadmin/
│   │   ├── page.tsx                    # Platform admin dashboard
│   │   └── help/page.tsx
│   └── api/  (see API Routes section)
│
├── lib/
│   ├── db/
│   │   ├── schema.ts                   # All Drizzle table definitions + relations
│   │   └── index.ts                    # db client, exports all tables
│   ├── auth.ts                         # Session create/verify (HMAC-signed JWT)
│   ├── league-auth.ts                  # getAuthorizedLeagueId()
│   ├── fpl.ts                          # FPL API calls + calculateTeamGameweekScore()
│   ├── fpl-cache.ts                    # Upstash Redis cache (FPL scores + live data)
│   ├── fixtures.ts                     # Round-robin fixture generation
│   ├── scoring.ts                      # TVT score/match point calculation
│   ├── chip-validation.ts              # Chip eligibility validation
│   └── id.ts                           # generateId() → UUID v4
│
└── middleware.ts                        # Auth, rate-limiting, session forwarding
```

---

## Database Schema (Drizzle ORM / Turso SQLite)

### `users`
| Column | Type | Notes |
|---|---|---|
| id | PK | UUID |
| email | unique text | |
| password | text | bcrypt hashed |
| name | text | |
| role | "superadmin"\|"admin" | |
| mustChangePassword | boolean | default true |
| createdAt / updatedAt | datetime | |

### `leagues`
| Column | Type | Notes |
|---|---|---|
| id | PK | UUID |
| slug | unique text | URL identifier |
| name | text | |
| sport | text | |
| format | text | |
| season | text | |
| isActive | boolean | |
| teamSize | 8\|16\|32 | teams per group |
| groupCount | 1\|2 | |
| playoffStartGw | integer | e.g. 31 (32-team), 36 (8-team) |
| enabledChips | text | JSON array e.g. `["D","W","C"]` |
| createdAt | datetime | |

### `leagueAdmins`
Maps admins to leagues. `(leagueId, userId)` unique.

### `groups`
| Column | Notes |
|---|---|
| id | PK |
| name | "A" or "B" |
| leagueId | FK → leagues |

Unique: `(leagueId, name)`

### `teams`
| Column | Notes |
|---|---|
| id | PK |
| name | team name |
| leagueId | FK → leagues |
| abbreviation | short name (display) |
| password | bcrypt hashed |
| mustChangePassword | boolean |
| groupId | FK → groups |
| leaguePoints | integer |
| bonusPoints | integer |
| doublePointerSet1Used | boolean |
| challengeChipSet1Used | boolean |
| winWinSet1Used | boolean |
| scoreLockSet1Used | boolean |
| comebackSet1Used | boolean |
| underdogSet1Used | boolean |
| doublePointerSet2Used | boolean |
| challengeChipSet2Used | boolean |
| winWinSet2Used | boolean |
| scoreLockSet2Used | boolean |
| comebackSet2Used | boolean |
| underdogSet2Used | boolean |

Unique: `(leagueId, name)`

### `players`
Two per team. Each has their own FPL team ID.
| Column | Notes |
|---|---|
| id | PK |
| name | display name |
| fplId | FPL team ID string |
| teamId | FK → teams |
| captaincyChipsUsed | integer (max 15 in league stage) |
| createdAt / updatedAt | |

### `gameweeks`
| Column | Notes |
|---|---|
| id | PK |
| number | 1–38 |
| leagueId | FK → leagues |
| deadline | datetime |
| isPlayoffs | boolean |
| createdAt / updatedAt | |

Unique: `(leagueId, number)`

### `fixtures`
| Column | Notes |
|---|---|
| id | PK |
| gameweekId | FK → gameweeks |
| homeTeamId | FK → teams |
| awayTeamId | FK → teams |
| groupId | FK → groups |
| isChallenge | boolean |
| isPlayoff | boolean |
| roundName | playoff round label |
| leg | 1 or 2 (two-legged ties) |
| tieId | FK → playoffTies |
| roundType | "tvt"\|"challenger-ko"\|"challenger-survival" |

### `results`
One row per processed fixture.
| Column | Notes |
|---|---|
| id | PK |
| fixtureId | FK → fixtures (unique) |
| teamId | FK → teams |
| homeScore / awayScore | integer (total team FPL scores) |
| homeMatchPoints / awayMatchPoints | 0/1/2 |
| homeGotBonus / awayGotBonus | boolean |
| homeUsedDoublePointer / awayUsedDoublePointer | boolean |
| homePlayerScores | JSON string — per-player breakdown |
| awayPlayerScores | JSON string — per-player breakdown |

**`homePlayerScores` / `awayPlayerScores` JSON shape:**
```json
[
  {
    "name": "PlayerName",
    "fplId": "123456",
    "fplScore": 60,
    "transferHits": 0,
    "isCaptain": true,
    "isAutoAssigned": false,
    "finalScore": 120
  }
]
```
`isAutoAssigned: true` means the captain was auto-assigned by the system (no import), not intentionally set.

### `gameweekCaptains`
Captain records per player per gameweek.
| Column | Notes |
|---|---|
| id | PK |
| gameweekId | FK → gameweeks |
| playerId | FK → players |
| fplScore | integer |
| transferHits | integer |
| doubledScore | integer |
| announcedAt | datetime |
| isValid | boolean — **false = auto-assigned**, true = explicitly imported |
| createdAt / updatedAt | |

### `gameweekChips`
One row per chip use.
| Column | Notes |
|---|---|
| id | PK |
| teamId | FK → teams |
| gameweekId | FK → gameweeks |
| chipType | "W"\|"D"\|"C"\|"SL"\|"CB"\|"UD" |
| challengedTeamId | FK → teams (Challenge Chip only) |
| isValid | boolean |
| validationErrors | text |
| isProcessed | boolean |
| pointsAwarded | integer |
| hadNegativeHits | boolean |
| teamRankAtValidation | integer |
| opponentRankAtValidation | integer |
| averageScoreAtUse | real |

### `playoffTies`
Aggregated two-legged playoff matchups.
| Column | Notes |
|---|---|
| tieId | PK |
| leagueId | FK → leagues |
| roundName | e.g. "QF-A", "SF-1", "Final" |
| roundType | "tvt"\|"challenger-ko"\|"challenger-survival" |
| homeTeamId / awayTeamId | FK → teams |
| homeAggregate / awayAggregate | integer |
| winnerId / loserId | FK → teams |
| gw1 / gw2 | gameweek numbers |
| status | "pending"\|"leg1_done"\|"complete" |

### `challengerSurvivalEntries`
Per-team scores in the GW33 Challenger Survival round.

### `settings`
Key-value store, PK on `(key, leagueId)`.

### `auditLogs`
Event log: type, description, teamId, gameweekId, pointsAffected, createdAt.

---

## API Routes

### Public (no auth)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/leagues` | List active leagues |
| GET | `/api/fixtures` | Fixtures grouped by GW. Params: `leagueSlug`, `gameweek`, `group`. Returns `playoffStartGw`. |
| GET | `/api/fixtures/live` | Live scores from Redis cache (10-min TTL). Params: `gameweek`, `leagueSlug` |
| POST | `/api/fixtures/live/refresh` | Force-refresh live cache from FPL API |
| GET | `/api/standings` | Standings. Params: `leagueSlug`, `group` |
| GET | `/api/gameweeks/[gw]` | Gameweek details. Params: `leagueId` |
| POST | `/api/gameweeks/[gw]` | Process GW scores. Params: `leagueId`, `force` (admin/cron) |
| GET | `/api/playoffs/bracket` | Playoff bracket state |

### Auth
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/signin` | Login (email or team name + password) |
| POST | `/api/auth/signout` | Logout |
| GET | `/api/auth/me` | Verify session |
| POST | `/api/auth/change-password` | Change password (rate-limited 5/min) |

### Team (team session required)
| Method | Path | Purpose |
|---|---|---|
| POST/GET | `/api/team/captain` | Announce / get captain for a GW |
| POST/GET | `/api/team/chips` | Announce / get chip status |
| GET | `/api/team/dashboard` | Personalized dashboard |
| GET | `/api/team/dashboard/gw-result` | GW result details |

### Admin `[leagueId]` (admin/superadmin required)
`leagueId` in URL can be UUID or league slug (resolved via `getAuthorizedLeagueId`).

| Method | Path | Purpose |
|---|---|---|
| POST/GET | `/api/admin/[leagueId]/create-team` | Create team / list teams |
| PUT | `/api/admin/[leagueId]/update-team` | Update team |
| DELETE | `/api/admin/[leagueId]/delete-team` | Delete team |
| POST | `/api/admin/[leagueId]/generate-fixtures` | Generate league-stage fixtures |
| POST/GET/DELETE | `/api/admin/[leagueId]/generate-playoffs` | Generate playoff bracket |
| POST | `/api/admin/[leagueId]/advance-playoffs` | Mark playoff leg complete |
| POST | `/api/admin/[leagueId]/bulk-upload-teams` | Bulk import teams (Excel) |
| POST | `/api/admin/[leagueId]/bulk-upload-fixtures` | Bulk import fixtures (Excel) |
| POST/GET | `/api/admin/[leagueId]/import-captains` | Import captains (Excel) / stats |
| POST | `/api/admin/[leagueId]/import-chips` | Import chips (Excel) |
| POST | `/api/admin/[leagueId]/override-captain` | Override captain |
| POST | `/api/admin/[leagueId]/override-chips` | Override chip validation |
| POST | `/api/admin/[leagueId]/reset-season` | Reset season (rate-limited 1/min) |
| GET/DELETE/POST | `/api/admin/[leagueId]/fpl-cache` | Cache stats / clear / detail |
| PUT | `/api/admin/[leagueId]/settings` | Update league settings |
| GET | `/api/admin/my-leagues` | Leagues this admin can manage |

### Superadmin
| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/superadmin/leagues` | List / create leagues |
| GET/PUT | `/api/superadmin/leagues/[id]` | Get / update league config |
| GET/POST | `/api/superadmin/admins` | List / create admins |
| DELETE | `/api/superadmin/admins/[userId]` | Delete admin |
| GET/POST | `/api/superadmin/league-assignments` | List / assign admin to league |

### Cron (CRON_SECRET Bearer token)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/cron/process-scores` | Auto-process live GW every 10 min |

---

## Middleware (`src/middleware.ts`)

Runs on all `/api/*` routes:

- **Public routes** (bypassed): `/api/auth/*`, GET `/api/fixtures`, GET `/api/standings`, GET `/api/leagues`, GET `/api/playoffs/bracket`, GET `/api/gameweeks/[gw]`
- **Rate limiting** via Upstash Redis: signin (5/min), change-password (5/min), reset-season (1/min)
- **Session verification**: reads `session` cookie → HMAC verify → forwards `x-session-id`, `x-session-type`, `x-league-id` headers
- **Cron auth**: checks `Authorization: Bearer CRON_SECRET`

---

## Key Library Details

### `src/lib/auth.ts`
```typescript
createSession(id: string, type: "superadmin"|"admin"|"team"): string
verifySession(token: string): { id, type, exp } | null
// HMAC-SHA256, 7-day expiry, cookie name: "session"
```

### `src/lib/league-auth.ts`
```typescript
getAuthorizedLeagueId(request: NextRequest): Promise<string | null>
// - Reads leagueId from URL path param [leagueId]
// - Accepts slug or UUID; resolves slug → UUID
// - Superadmins: unrestricted
// - Admins: must be in leagueAdmins table + league.isActive
```

### `src/lib/fpl.ts`
```typescript
fetchBootstrapData(): Promise<any>
fetchTeamEntry(teamId: string): Promise<FPLTeamEntry>
fetchTeamGameweekPicks(teamId: string, gameweek: number): Promise<FPLGameweekPicks>
fetchLiveGameweek(gameweek: number): Promise<FPLLiveData>
fetchTeamHistory(teamId: string): Promise<any>
calculateTeamGameweekScore(teamId: string, gameweek: number, leagueId?: string | null): Promise<{points, transferHits, netScore}>
// Checks cache first; writes to cache on miss
detectLiveGameweek(): Promise<{ liveGw: number|null, gwStatus: Record<number, "notStarted"|"inProgress"|"finished"> }>
// Checks GW31–38 for active playoff fixtures without results
```

### `src/lib/fpl-cache.ts`

**FPL score cache** (24h TTL, league-namespaced):
- Key format: `fpl:{leagueId ?? "global"}:gw{N}:{fplId}`

```typescript
getCachedScore(fplId, gameweek, leagueId?): Promise<CachedScore|null>
setCachedScore(fplId, gameweek, score, leagueId?): Promise<void>
isGameweekFullyCached(fplIds, gameweek, leagueId?): Promise<boolean>
getAllCachedScores(gameweek, leagueId?): Promise<Record<string, CachedScore>>
clearGameweekCache(gameweek, leagueId?): Promise<void>
clearGameweekCacheForIds(gameweek, fplIds, leagueId?): Promise<void>
getCacheStatsForIds(fplIds, leagueId?): Promise<{gameweek, entries}[]>
getAllCachedScoresForIds(gameweek, fplIds, leagueId?): Promise<Record<string, CachedScore>>
getCacheStats(leagueId?): Promise<{gameweek, entries}[]>
```

`getAllCachedScores` returns keys as `"{fplId}_gw{N}"` for caller parsing.

**Live score cache** (10-min TTL, league-namespaced):
- Key format: `live:gw{N}:{leagueId ?? "all"}`

```typescript
getLiveCachedScores(gameweek, leagueId?): Promise<LiveGameweekData|null>
setLiveCachedScores(gameweek, data, leagueId?): Promise<void>
clearLiveCache(gameweek, leagueId?): Promise<void>
```

`LiveFixtureScore` shape:
```typescript
{
  fixtureId, gameweek, homeTeamName, awayTeamName,
  homeTeamAbbr, awayTeamAbbr, homeScore, awayScore,
  homePlayers: { name, fplId, fplScore, transferHits, isCaptain, finalScore }[],
  awayPlayers: [same]
}
```

### `src/lib/scoring.ts`
```typescript
calculateTVTTeamScore(players: PlayerScore[]): number
// Sum of both players' net scores; captain score × 2
determineMatchResult(homeScore, awayScore, isDP_home, isDP_away)
// → { homeScore, awayScore, homeMatchPoints, awayMatchPoints,
//     margin, homeGotBonus, awayGotBonus }
// Win = 2pts, Draw = 1pt, Loss = 0pt (doubled if Double Pointer)
// Bonus: win by 75+ points
getChipSet(gameweek, playoffStartGw): 1|2|"playoffs"
compareTiebreaker(a, b): number   // re-exported from ./tiebreaker.ts
// Order: leaguePoints > wins > h2h > cbpPoints > pointsFor
// Canonical for /api/standings, playoff seeding and the bracket preview.
// Lives in tiebreaker.ts (zero imports) so it stays unit-testable without a DB.
```

### `src/lib/fixtures.ts`
```typescript
generateRoundRobinFixtures(teams, repetitions): {homeTeamId, awayTeamId, gameweekNumber}[]
```

---

## TVT Game Rules

### Team Structure
- Each team = 2 FPL managers (players)
- Team score = player1 net score + player2 net score
- Captain's net score is **doubled** (net = FPL points − transfer hits)

### Match Points
- Win = 2, Draw = 1, Loss = 0
- Double Pointer chip: match points doubled
- Bonus point: win by ≥75 points (doubled if Double Pointer used)

### Hit Penalty
- If any player takes >12 transfer hits in a GW → team loses 1 league point that GW (carry-forward deduction applied in the *next* GW's processing)

### Chips (TVT chips, separate from FPL chips)
Chips come in sets. Each set has 3 chips usable once per set.

| Chip | Code | Effect |
|---|---|---|
| Double Pointer | D | Doubles match points earned |
| Win-Win | W | Guaranteed +2 league points (voided if player has negative net score) |
| Challenge | C | Challenge top-2 of opposite group for +2 pts if you win |
| Score Lock | SL | Floors team score to season average |
| Comeback | CB | Bonus if trailing at GW deadline |
| Underdog | UD | Bonus if lower-ranked beats higher-ranked |

League `enabledChips` JSON controls which chips are active per league.

### Chip Sets (32/16-team leagues)
- Set 1: GW1–15
- Set 2: GW16–30
- Playoffs: separate rules

### Captaincy
- Max **15 captaincy chips** per player in league stage
- `gameweekCaptains.isValid = false` → auto-assigned (penalty: lowest scorer becomes captain)
- `gameweekCaptains.isValid = true` → explicitly imported by admin

### Auto-Assignment
When no captain is imported for a GW before processing, `autoAssignDefaultCaptain()` runs and creates a `gameweekCaptains` record with `isValid: false`. The lowest-scoring player is made captain (punitive). The `isAutoAssigned` flag in `homePlayerScores`/`awayPlayerScores` JSON distinguishes these from intentional captains — the "C" badge on fixture cards is **not shown** for auto-assigned captains.

---

## League Formats & Playoff Structures

### 32-Team League (`playoffStartGw = 31`)
- 2 groups (A, B), 16 teams each
- League stage: GW1–30
- Playoffs (GW31–38):
  - Ranks 1–8: TVT Title track (RO16 → QF → SF → Final)
  - Ranks 9–14: Challenger Series
  - Ranks 15–16: Eliminated

### 16-Team League (`playoffStartGw` varies)
- 2 groups (A, B), 8 teams each
- 4-team group stage → SF → Final + Challenger rounds

### 8-Team League (`playoffStartGw = 36`)
- 1 group (A), 8 teams
- League stage: GW1–35
- Playoffs: SF → Final (GW36–38)

---

## GW Processing Flow (`POST /api/gameweeks/[gw]`)

1. Fetch gameweek record for `leagueId` + `gwNumber`
2. Identify unprocessed fixtures (no result yet)
3. Build carry-forward hit map from GW N-1 cache (`getAllCachedScores(N-1, leagueId)`)
4. For each fixture:
   - Fetch FPL scores for all 4 players via `calculateTeamGameweekScore(fplId, gw, leagueId)`
   - Resolve captains from `gameweekCaptains`; auto-assign if missing
   - Apply chip logic (Double Pointer, Win-Win, Challenge, etc.)
   - Calculate team scores, match points, bonus
   - Write `results` row with `homePlayerScores` / `awayPlayerScores` JSON
5. Update team `leaguePoints`, `bonusPoints`
6. Process group margins for bonus points
7. Process chip outcomes

Supports `force=true` to reprocess already-completed GWs.

---

## Admin Preview URLs

Global pages support `?adminLeague=<slug>` to preview a specific league:
- `/fixtures?adminLeague=tvt-8-teams`
- `/standings?adminLeague=tvt-8-teams`
- `/playoffs?adminLeague=tvt-8-teams`

These pages forward `leagueSlug` to all API calls including live score fetches.

---

## Fixtures Page — GW Selector Logic

Both `/fixtures/page.tsx` (global) and `/[leagueSlug]/fixtures/page.tsx` (league-scoped):
- Fetch `/api/fixtures?leagueSlug=...`
- API returns `playoffStartGw` for the league
- GW selector is capped at `playoffStartGw - 1` (league phase only; playoffs shown on `/playoffs` page)
- When no league is specified, `playoffStartGw` is `null` → all GWs shown

---

## Session & Auth Flow

- Sessions are HMAC-signed tokens stored in `session` cookie
- Three session types: `"superadmin"`, `"admin"`, `"team"`
- Team sessions identify by team UUID; admin/superadmin by user UUID
- `mustChangePassword` flag forces redirect to `/change-password` on next login
- Rate limiting uses Upstash Redis sliding window counters

---

## Notable Patterns & Conventions

- **League isolation**: All cache keys, DB queries, and admin operations are scoped by `leagueId`. A superadmin can access all; an admin only their assigned leagues.
- **`leagueId` resolution**: URL path params can be UUID or slug. `getAuthorizedLeagueId()` resolves either form.
- **Bulk imports**: Excel files parsed server-side with `xlsx`. Captain and chip imports iterate GW columns (named `"1"`, `"2"`, ..., or `"GW1"`, etc.).
- **`isValid` on captains**: `false` = auto-assigned (system penalty), `true` = admin-imported.
- **Drizzle ORM**: Schema in `src/lib/db/schema.ts`; all tables re-exported from `src/lib/db/index.ts`.
- **No `leagueId` in `players` table**: Players belong to teams; queries join via `teamId` → `teams.leagueId`.
- **`homePlayerScores` is a JSON string** stored in the `results` table, not a separate table.
- **Cron job** (`/api/cron/process-scores`): Runs every 10 min on Vercel, calls `POST /api/gameweeks/[gw]?force=true` with detected live GW.
