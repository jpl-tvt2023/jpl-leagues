# JPL India — Fantasy Football League Management

A full-stack web application for running **TVT Fantasy Football** leagues on top of the Fantasy Premier League (FPL) platform. Supports three league variants (32-team, 16-team, 8-team), multi-league management, playoff bracket generation, live FPL score fetching, and a 6-chip system that adds strategic depth beyond standard FPL.

---

## Table of Contents

1. [What is TVT?](#what-is-tvt)
2. [League Variants](#league-variants)
3. [Tech Stack](#tech-stack)
4. [Project Structure](#project-structure)
5. [Database Schema](#database-schema)
6. [Authentication & Roles](#authentication--roles)
7. [Chip System](#chip-system)
8. [Scoring Rules](#scoring-rules)
9. [Playoff Structures](#playoff-structures)
10. [API Reference](#api-reference)
11. [Environment Variables](#environment-variables)
12. [Local Development](#local-development)
13. [Database Management](#database-management)
14. [Deployment](#deployment)

---

## What is TVT?

**TVT (Two vs Two)** is a fantasy football format where:

- Teams consist of **2 FPL managers** playing together
- Each gameweek, your **combined FPL score** (minus transfer hits) is your team's score
- One player is nominated as **Captain** — their net score is **doubled**
- Teams play **head-to-head matches** each gameweek
- Win = **2 league points**, Draw = **1**, Loss = **0**
- Strategic **chips** can be played to gain extra points or alter match results
- A **league stage** of 30–35 gameweeks is followed by a **playoff knockout**

---

## League Variants

Three formats are supported, selectable at league creation:

### 32-Team (2 Groups of 16)

| Property | Value |
|----------|-------|
| Teams | 32 |
| Groups | 2 × 16 (Group A + Group B) |
| League Stage | GW1 – GW30 |
| Chip Set 1 | GW1 – GW15 |
| Chip Set 2 | GW16 – GW30 |
| Playoffs Start | GW31 |
| Playoffs End | GW38 |

**Zone cutoffs (per group):**
- Rank 1–8 → Title Play-offs (green)
- Rank 9–14 → Challenger Series (yellow)
- Rank 15–16 → Eliminated (red)

**Playoff bracket:**
```
Title Path:      RO16 (GW31-32) → QF (GW33-34) → SF (GW35-36) → Final (GW37-38)
Challenger Path: C-31 → C-32 → C-33 Survival → C-34 → C-35 → C-36 → C-37 → C-38
Eliminated:      Ranks 15–16 per group
```
Cross-group seeding: Group A rank 1 vs Group B rank 8, etc.

---

### 16-Team (1 Group of 16)

| Property | Value |
|----------|-------|
| Teams | 16 |
| Groups | 1 × 16 |
| League Stage | GW1 – GW30 |
| Chip Set 1 | GW1 – GW15 |
| Chip Set 2 | GW16 – GW30 |
| Playoffs Start | GW31 |
| Playoffs End | GW36 |

**Zone cutoffs:**
- Rank 1–8 → Title Play-offs (green)
- Rank 9–14 → Challenger Series (yellow)
- Rank 15–16 → Eliminated (red)

**Playoff bracket:**
```
Title Path:
  QF (GW31-32, 2-legged): 1v8, 2v7, 3v6, 4v5
  → SF (GW33-34) → Final (GW35-36)

Challenger Path:
  C-31 (GW31, single-leg): 9v14, 10v13, 11v12
  → C-32 → C-33 Survival (with QF losers) → C-34 → C-35 → C-36

Eliminated: Ranks 15–16
```

---

### 8-Team (1 Group of 8)

| Property | Value |
|----------|-------|
| Teams | 8 |
| Groups | 1 × 8 |
| League Stage | GW1 – GW35 (5× round-robin) |
| Chip Set 1 | GW1 – GW17 |
| Chip Set 2 | GW18 – GW35 |
| Playoffs Start | GW36 |
| Playoffs End | GW38 |

**Zone cutoffs:**
- Rank 1–4 → Title Play-offs (green)
- Rank 5–8 → Eliminated (red)
- No Challenger Series

**Playoff bracket:**
```
GW36: SF-A (1 vs 4, single-leg) | SF-B (2 vs 3, single-leg)
GW37: 3rd Place Match (SF losers, single-leg)
      Final Leg 1 (SF winners)
GW38: Final Leg 2
Ranks 5–8: Eliminated after league stage
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Next.js 16.1.6](https://nextjs.org) (App Router) |
| Language | TypeScript 5 |
| UI | React 19.2.3 + [Tailwind CSS v4](https://tailwindcss.com) |
| Database | [Turso (LibSQL)](https://turso.tech) — SQLite-compatible cloud DB |
| ORM | [Drizzle ORM 0.45](https://orm.drizzle.team) |
| Auth | Custom HMAC-SHA256 signed session tokens |
| Rate Limiting | [Upstash Redis](https://upstash.com) |
| FPL Data | Fantasy Premier League public API |
| Password Hashing | bcryptjs |
| Spreadsheet Import | xlsx |
| Dev Runtime | Turbopack (`next dev --webpack`) |

---

## Project Structure

```
jpl-leagues/
├── src/
│   ├── app/                          # Next.js App Router pages and API routes
│   │   ├── layout.tsx                # Root layout (metadata, fonts)
│   │   ├── page.tsx                  # Public home — league list
│   │   ├── signin/page.tsx           # Login page (teams + admins)
│   │   ├── dashboard/page.tsx        # Team dashboard (captain, chips, GW results)
│   │   ├── change-password/page.tsx  # First-login password change
│   │   ├── standings/page.tsx        # Legacy single-league standings
│   │   ├── fixtures/page.tsx         # Legacy single-league fixtures
│   │   ├── playoffs/page.tsx         # Legacy single-league playoffs
│   │   ├── rules/page.tsx            # League rules (auth-gated)
│   │   ├── superadmin/page.tsx       # Superadmin control panel
│   │   ├── admin/
│   │   │   ├── page.tsx              # Admin league selector
│   │   │   └── [leagueId]/page.tsx   # Per-league admin panel (teams, scoring, chips, playoffs)
│   │   ├── [leagueSlug]/             # Public per-league pages
│   │   │   ├── standings/page.tsx
│   │   │   ├── fixtures/page.tsx
│   │   │   └── playoffs/page.tsx
│   │   └── api/                      # API routes (37 files)
│   │       ├── auth/                 # signin, signout, me, change-password
│   │       ├── admin/[leagueId]/     # Admin operations (14 routes)
│   │       ├── team/                 # captain, chips, dashboard, gw-result
│   │       ├── cron/                 # Automated score processing
│   │       ├── fixtures/             # Fixture listing, generation, live scores
│   │       ├── gameweeks/[gw]/       # GW deadline info
│   │       ├── leagues/              # Public league list
│   │       ├── standings/            # Standings data
│   │       ├── playoffs/bracket/     # Playoff bracket data
│   │       └── superadmin/           # Platform admin (admins, leagues, assignments)
│   ├── components/
│   │   └── StandingsTable.tsx        # Shared standings table with CP/BP tooltip
│   ├── types/
│   │   └── standings.ts              # TeamStanding, ChipTooltipEntry interfaces
│   └── lib/
│       ├── db/
│       │   ├── index.ts              # Drizzle client (LibSQL connection)
│       │   └── schema.ts             # Complete database schema + relations
│       ├── auth.ts                   # Session create/verify (HMAC-SHA256)
│       ├── scoring.ts                # TVT scoring engine, getChipSet()
│       ├── fixtures.ts               # Round-robin fixture generation
│       ├── chip-validation.ts        # TVT chip rules validation
│       ├── fpl.ts                    # FPL API integration
│       ├── fpl-cache.ts              # FPL data caching via Upstash Redis
│       ├── league-auth.ts            # Per-league admin authorization helper
│       ├── api-response.ts           # apiError() / apiOk() helpers
│       └── id.ts                     # ID generation utility
├── scripts/
│   └── seed-admin.ts                 # Create initial superadmin account
├── public/                           # Static assets
├── next.config.ts                    # Security headers config
├── tailwind.config.ts
├── postcss.config.js
├── tsconfig.json
├── drizzle.config.ts                 # Drizzle ORM configuration
└── package.json
```

---

## Database Schema

### Tables Overview

| Table | Purpose |
|-------|---------|
| `users` | Admin and superadmin accounts |
| `leagues` | League instances with variant config |
| `league_admins` | Maps admins to their leagues |
| `groups` | Groups (A/B) within a league |
| `teams` | TVT teams (2 players) — also login credentials |
| `players` | Individual FPL managers within a team |
| `gameweeks` | GW1–38 with deadlines and phase flags |
| `fixtures` | Head-to-head matches (league + playoff) |
| `results` | Match outcomes with scores and chip flags |
| `gameweek_captains` | Captain selection per team per GW |
| `gameweek_chips` | TVT chip plays |
| `playoff_ties` | Playoff matchups with aggregate tracking |
| `challenger_survival_entries` | GW33 survival format entries |
| `settings` | League-scoped key-value config |
| `audit_logs` | Penalty, bonus, and event tracking |

### Key Column Details

#### `leagues`
```
id, slug, name, sport, format, season, is_active
team_size          -- 8 | 16 | 32 (default 32)
group_count        -- 1 | 2 (default 2)
playoff_start_gw   -- 31–36 (default 31)
enabled_chips      -- JSON array of 3 chip codes, e.g. '["D","W","C"]'
```

#### `teams`
```
id, name, league_id, abbreviation, password, must_change_password
group_id, league_points, bonus_points
-- Chip usage flags (12 total: 6 chips × 2 sets):
double_pointer_set1_used, challenge_chip_set1_used, win_win_set1_used
score_lock_set1_used, comeback_set1_used, underdog_set1_used
double_pointer_set2_used, challenge_chip_set2_used, win_win_set2_used
score_lock_set2_used, comeback_set2_used, underdog_set2_used
```

#### `fixtures`
```
id, gameweek_id, home_team_id, away_team_id, group_id
is_challenge, is_playoff
round_name    -- "RO16", "QF", "SF", "Final", "C-31", etc.
leg           -- 1 or 2 (null for single-leg)
tie_id        -- FK to playoff_ties
round_type    -- "tvt" | "challenger-ko" | "challenger-survival"
```

#### `gameweek_chips`
```
id, team_id, gameweek_id
chip_type            -- "W" | "D" | "C" | "SL" | "CB" | "UD"
challenged_team_id   -- Challenge Chip target
is_valid, validation_errors
is_processed, points_awarded
had_negative_hits    -- Win-Win wasted if true
team_rank_at_validation, opponent_rank_at_validation
average_score_at_use -- Score Lock: season average stored at play time
```

---

## Authentication & Roles

### Session System

Sessions are custom HMAC-SHA256 signed tokens (no JWT library dependency):

```
token = base64url(JSON payload) + "." + HMAC-SHA256(payload, SESSION_SECRET)
```

- Payload: `{ id, type, exp }` — expires after **7 days**
- Stored in an `HttpOnly; SameSite=Lax` cookie named `session`
- Verification uses constant-time comparison to prevent timing attacks

### Roles

| Role | Login | Access |
|------|-------|--------|
| `superadmin` | Email + password | Full platform access: create leagues, manage admins, view all data |
| `admin` | Email + password | League-scoped: manage teams, process scores, override chips/captains |
| `team` | Team name + password | Team dashboard: submit captain, play chips, view standings/fixtures |

### Middleware

`src/middleware.ts` runs on all `/api/*` routes and:

1. **Rate limits** signin/change-password (5 req/min) and reset-season (1 req/min) per IP via Upstash Redis
2. **Allows public GET** routes: `/api/standings`, `/api/fixtures`, `/api/playoffs/bracket`, `/api/leagues`, `/api/gameweeks/[gw]`
3. **Validates session cookie** for all protected routes
4. **Enforces role** — admin routes require `admin` or `superadmin`; team routes require `team`
5. **Injects headers** (`x-session-id`, `x-session-type`, `x-league-id`) for route handlers
6. **Cron support** — Vercel cron jobs authenticate via `Authorization: Bearer <CRON_SECRET>`

### League-Scoped Admin Auth

`src/lib/league-auth.ts` verifies that an admin's session ID corresponds to a user assigned to the requested `leagueId`. Superadmins bypass this check.

---

## Chip System

Each league is configured with exactly **3 enabled chips** (chosen at creation). There are 6 available chip types. Each chip can be played **once per set** (Set 1 and Set 2). No chips are available during the playoff phase.

### Chip Set Boundaries

```
Midpoint = Math.ceil((playoffStartGw - 1) / 2)

Set 1: GW1 – Midpoint
Set 2: GW(Midpoint+1) – GW(playoffStartGw - 1)
Playoffs: No chips

32-team / 16-team (playoffStartGw=31): Set1 GW1-15, Set2 GW16-30
8-team (playoffStartGw=36):            Set1 GW1-17, Set2 GW18-35
```

### The 6 Chips

#### Win-Win (W)
- Awards **+2 league points** regardless of match result
- If the team has **net negative transfer hits** in that GW, the chip is wasted (counted as used, no points)
- Useful for guaranteeing points when you expect a low score

#### Double Pointer (D)
- **Doubles** your TVT league points for that gameweek
- A win becomes **+4 pts**, draw **+2 pts**, loss **0 pts**
- Requires you to be ranked **3+ places below** your opponent *(Underdog condition)* — no, wait: Double Pointer has no rank restriction; Underdog does
- Best played in a week you're confident of winning

#### Challenge Chip (C)
- Challenge one of the **top-2 ranked teams from the opposite group** (32-team only)
- Creates an additional head-to-head fixture that GW
- Win the challenge → earn **+2 extra league points**
- If you lose, no points are deducted

#### Score Lock (SL)
- Your GW score is **guaranteed to be at least your season average**
- At the time you play the chip, your `season average = total FPL points scored ÷ GWs played` is recorded
- If your actual GW score is below that average, the average is used instead for the match calculation
- Protects you against a bad GW

#### Comeback (CB)
- If you **lost the previous gameweek** and **win this gameweek**, you earn **+1 extra league point**
- Chip must be played before the GW deadline
- No benefit if you won or drew last week

#### Underdog (UD)
- If you are ranked **3 or more places below** your opponent (they are ranked 3+ higher than you) and you **win**, you earn **+1 extra league point**
- Rank snapshot is taken at the time of processing
- Encourages taking on higher-ranked teams

### Chip Tooltip (Standings)

The CP/BP column in the standings table shows a breakdown on hover/tap:
- Each chip's status: **Available**, **Pending** (played, awaiting result), or the points awarded
- BPS (Bonus Points System) entries per GW
- Hit Penalty deductions
- Total CP/BP

---

## Scoring Rules

### Team Score Calculation

```
Team Score = sum of both players' net scores
Net Score  = FPL Score − Transfer Hits
Captain's Net Score is DOUBLED
```

**Example:**
- Player A (captain): FPL 72, 1 hit → net 72 − 4 = 68 → doubled = 136
- Player B: FPL 55, 0 hits → net 55
- Team Score = 136 + 55 = **191**

### Match Points

| Result | Home | Away |
|--------|------|------|
| Home win | **2** | 0 |
| Draw | **1** | **1** |
| Away win | 0 | **2** |

### Bonus Points

Bonus points (BP) are awarded based on match margin:
- Applied cumulatively across the season
- Visible in the CP/BP column breakdown

### League Point Tiebreakers

Defined once in `src/lib/formats/tvt/tiebreaker.ts` (`compareTiebreaker`) and shared by
`/api/standings`, playoff seeding and the bracket preview — the displayed table and the
generated bracket always resolve ties identically.

1. Most **league points**
2. Most **wins**
3. **Head-to-head** match points between the tied teams
4. Most **CP/BP points** (chips + bonus)
5. Highest **total FPL score** (Points For)

### Hit Penalty System

Transfer hits that exceed the free transfer quota are deducted from a player's FPL score before the team score is calculated. The hit penalties are tracked per GW and visible in the CP/BP tooltip.

---

## Playoff Structures

### Title Playoffs (32-team, example)

```
GW31-32: Round of 16 (2-legged)
  Group A: 1v16, 2v15, 3v14, 4v13, 5v12, 6v11, 7v10, 8v9
  Group B: same within group
  Cross-seeding: A1 vs B8, A2 vs B7, ... A8 vs B1

GW33-34: Quarter-Finals (2-legged, 8 winners from RO16)
GW35-36: Semi-Finals (2-legged, 4 winners from QF)
GW37-38: Final (2-legged, 2 winners from SF)
```

### Challenger Series (32-team)

```
GW31: C-31 — first knockouts
GW32: C-32
GW33: C-33 — Survival round (all remaining Challenger teams score individually; bottom teams eliminated)
GW34: C-34
GW35: C-35
GW36: C-36
GW37: C-37
GW38: C-38 — Challenger Final
```

### Aggregate Scoring (2-legged ties)

Both legs are played on consecutive GWs. The team with the **higher combined score** over both legs advances. If tied, the team that scored more in **Leg 2** (away goals equivalent) advances.

---

## API Reference

All routes under `/api/`. Public GET routes require no auth.

### Auth (`/api/auth/`)

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/api/auth/signin` | None | Sign in (team or admin). Returns session cookie |
| POST | `/api/auth/signout` | None | Clear session cookie |
| GET | `/api/auth/me` | None | Returns `{ authenticated, type, id }` |
| POST | `/api/auth/change-password` | Session | Change own password |

### Public Data

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/leagues` | List all active leagues |
| GET | `/api/standings?leagueSlug=X` | Standings for a league |
| GET | `/api/fixtures?leagueSlug=X` | Fixtures for a league |
| GET | `/api/fixtures/live?leagueSlug=X` | Live GW scores |
| POST | `/api/fixtures/live/refresh` | Force-refresh live scores from FPL |
| GET | `/api/playoffs/bracket?leagueSlug=X` | Playoff bracket data |
| GET | `/api/gameweeks/[gw]` | GW deadline and phase info |

### Team Portal (`/api/team/`)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/team/dashboard` | Full dashboard data (standings, fixtures, chip status) |
| GET | `/api/team/dashboard/gw-result` | Latest GW result with breakdown |
| GET/POST/DELETE | `/api/team/captain` | Get/set/clear captain for upcoming GW |
| GET/POST/DELETE | `/api/team/chips` | Get chip status / play / retract a chip |

### Admin (`/api/admin/[leagueId]/`)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/admin/my-leagues` | Leagues assigned to this admin |
| POST | `…/create-team` | Create a new team with 2 players |
| PATCH | `…/update-team` | Update team name/abbreviation/group |
| DELETE | `…/delete-team` | Delete team and all associated data |
| POST | `…/bulk-upload-teams` | Import teams from CSV/XLSX |
| POST | `…/bulk-upload-fixtures` | Import fixtures from CSV/XLSX |
| POST | `…/override-captain` | Admin override for captain selection |
| POST | `…/import-captains` | Bulk import captains from CSV |
| POST | `…/override-chips` | Admin add/remove chip for a team |
| POST | `…/import-chips` | Bulk import chips from CSV |
| POST | `…/generate-playoffs` | Generate playoff bracket |
| POST | `…/advance-playoffs` | Advance a playoff tie after legs complete |
| GET/POST | `…/settings` | Get/update league settings |
| POST | `…/reset-season` | Full season reset (delete all data) |
| POST | `…/fpl-cache` | Manually trigger FPL data cache refresh |

### Superadmin (`/api/superadmin/`)

| Method | Route | Description |
|--------|-------|-------------|
| GET/POST | `/api/superadmin/admins` | List/create admin accounts |
| DELETE | `/api/superadmin/admins/[userId]` | Delete admin |
| GET/POST | `/api/superadmin/leagues` | List/create leagues |
| PATCH/DELETE | `/api/superadmin/leagues/[id]` | Update/delete a league |
| POST | `/api/superadmin/league-assignments` | Assign admin to league |

### Cron (`/api/cron/`)

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/api/cron/process-scores` | Bearer token | Fetch FPL scores, calculate results, award points |

---

## Environment Variables

Create a `.env.local` file in the project root:

```env
# Turso (LibSQL) Database
TURSO_CONNECTION_URL=libsql://your-db-name.region.turso.io
TURSO_AUTH_TOKEN=your_turso_auth_token

# Upstash Redis (rate limiting + FPL cache)
UPSTASH_REDIS_REST_URL=https://your-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_upstash_token

# Session signing key (min 32 characters, keep secret)
SESSION_SECRET=your_very_long_random_secret_string_min_32_chars

# Cron job authentication (Vercel cron sends this as Bearer token)
CRON_SECRET=your_cron_secret
```

| Variable | Required | Purpose |
|----------|----------|---------|
| `TURSO_CONNECTION_URL` | Yes | LibSQL database URL |
| `TURSO_AUTH_TOKEN` | Yes | Turso authentication token |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis URL for rate limiting and caching |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis token |
| `SESSION_SECRET` | Yes | HMAC key for signing session tokens (≥32 chars) |
| `CRON_SECRET` | Yes (prod) | Shared secret for Vercel cron job authentication |

---

## Local Development

### Prerequisites

- Node.js 20+
- npm 10+
- A Turso account (free tier works)
- An Upstash account (free tier works)

### Setup

```bash
# 1. Clone the repo
git clone <repo-url>
cd jpl-leagues

# 2. Install dependencies
npm install

# 3. Create environment file
cp .env.example .env.local
# Edit .env.local with your credentials

# 4. Push the schema to your Turso database
npm run db:push

# 5. Seed the initial superadmin account
npm run seed:admin

# 6. Start the development server
npm run dev
```

The app runs at [http://localhost:3000](http://localhost:3000).

> **Note:** `npm run dev` uses `--webpack` flag for Turbopack compatibility.

### Default Superadmin Credentials

After running `seed:admin`, log in at `/signin` with the credentials defined in `scripts/seed-admin.ts`. You will be prompted to change the password on first login.

---

## Database Management

### Push Schema Changes

After modifying `src/lib/db/schema.ts`:

```bash
npm run db:push
```

This syncs the schema directly to the live Turso database without generating migration files. Appropriate for pre-production development.

### Browse Database

```bash
npm run db:studio
```

Opens Drizzle Studio at `https://local.drizzle.studio`.

### Cascade Delete Order

When deleting a league, data must be removed in this order to respect foreign keys:
1. `results`
2. `challengerSurvivalEntries`
3. `gameweekChips`
4. `fixtures`
5. `playoffTies`
6. `players`
7. `settings`
8. `leagueAdmins`
9. `teams`
10. `groups`
11. `gameweeks`
12. `leagues`

---

## Deployment

### Vercel (Recommended)

1. Connect the repository to Vercel
2. Set all environment variables in the Vercel dashboard
3. Configure a cron job in `vercel.json` to call `/api/cron/process-scores`

**vercel.json example:**
```json
{
  "crons": [
    {
      "path": "/api/cron/process-scores",
      "schedule": "0 */3 * * *"
    }
  ]
}
```

### Security Headers

The following headers are set on all responses via `next.config.ts`:
- `X-Frame-Options: DENY` — prevents clickjacking
- `X-Content-Type-Options: nosniff` — prevents MIME sniffing
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

---

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| Dev server | `npm run dev` | Start Next.js with Turbopack |
| Build | `npm run build` | Production build |
| Start | `npm run start` | Start production server |
| Lint | `npm run lint` | ESLint check |
| Push schema | `npm run db:push` | Sync schema.ts → Turso DB |
| Generate migrations | `npm run db:generate` | Generate migration files (dev only) |
| DB Studio | `npm run db:studio` | Open Drizzle Studio |
| Seed admin | `npm run seed:admin` | Create initial superadmin account |

---

## Key Architectural Decisions

### No Migration Files
The project uses `drizzle-kit push` to sync schema changes directly to the database. This is appropriate for pre-production. If you need to preserve data across schema changes in production, switch to `drizzle-kit generate` + `drizzle-kit migrate`.

### Session Tokens vs JWT
Custom HMAC-SHA256 tokens instead of a JWT library. The payload is base64url-encoded JSON, signed with a server secret. Simpler, no external dependency, and fully auditable.

### FPL API Caching
All FPL API responses are cached in Upstash Redis to avoid rate-limiting from the FPL API. The cache can be manually invalidated from the admin panel (`fpl-cache` route) or via the live scores refresh endpoint.

### Multi-League Architecture
Every data table (teams, fixtures, results, etc.) is scoped to a `league_id`. Admins can only access leagues they are assigned to. The superadmin has unrestricted access across all leagues.

### `getChipSet()` — Single Source of Truth
`src/lib/scoring.ts` contains the canonical `getChipSet(gameweek, playoffStartGw)` function. All chip validation, scoring, and dashboard routes import from here to ensure consistent set boundary calculations across all league variants.
