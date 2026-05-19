import { sqliteTable, text, integer, real, uniqueIndex, primaryKey, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

// ============================================
// TVT Fantasy Super League Database Schema
// ============================================

// Admin accounts only
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  name: text("name").notNull(),
  // "superadmin" = platform owner (full access); "admin" = league-scoped admin
  role: text("role").notNull().default("admin"),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ============================================
// Multi-League Infrastructure
// ============================================

export const leagues = sqliteTable("leagues", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(), // e.g. "tvt-fpl", "tvt-cricket"
  name: text("name").notNull(),
  sport: text("sport").notNull(), // "fpl" | "cricket"
  format: text("format").notNull(), // "tvt" | "classic" | "grand-prix" | "auction"
  season: text("season").notNull(), // e.g. "2025-26"
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),

  // Variant config (TVT Football)
  // teamSize: total teams in the league (8 | 16 | 32)
  // groupCount: number of groups (1 | 2); teamsPerGroup = teamSize / groupCount
  // playoffStartGw: first playoff gameweek (31–36); league stage = GW1 to playoffStartGw-1
  // enabledChips: JSON array of exactly 3 chip codes chosen at creation time
  //   Available codes: "W" (Win-Win), "D" (Double Pointer), "C" (Challenge Chip),
  //                    "SL" (Score Lock), "CB" (Comeback), "UD" (Underdog)
  //   Example: '["D","W","C"]' (default = classic three)
  teamSize: integer("team_size").notNull().default(32),
  groupCount: integer("group_count").notNull().default(2),
  playoffStartGw: integer("playoff_start_gw").notNull().default(31),
  enabledChips: text("enabled_chips").notNull().default('["D","W","C"]'),

  // JPL Auction config
  initialBudget: integer("initial_budget").notNull().default(100_000_000),
  isSimulated: integer("is_simulated", { mode: "boolean" }).notNull().default(false), // Testing: auto-assign players via snake draft

  // JPL Auction: PL Club Auction toggle — when on, league boots with a `club-auction` session
  // before the `initial` player auction. Each team buys 1 PL club giving ×1.5 synergy on
  // owned players from that club + per-GW result bonus when the club wins/draws.
  clubAuctionEnabled: integer("club_auction_enabled", { mode: "boolean" }).notNull().default(false),

  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Maps non-superadmin users to leagues they can administer
export const leagueAdmins = sqliteTable("league_admins", {
  id: text("id").primaryKey(),
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (table) => ({
  leagueUserUnique: uniqueIndex("league_admins_league_user_unique").on(table.leagueId, table.userId),
}));

// Group (A or B for TVT; Cup-A/B/C/D for Triple Crown)
export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  groupType: text("group_type").default("pl"), // "pl" | "cup" (Triple Crown uses "cup" for cup groups)
}, (table) => ({
  leagueNameUnique: uniqueIndex("groups_league_name_unique").on(table.leagueId, table.name),
}));

// Team (2 players per team) - also acts as login account
export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  teamLoginId: text("team_login_id"), // Global login credential (set by admin, editable by team during setup)
  name: text("name").notNull(), // Team display name (set by team during setup, unique per league)
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  password: text("password").notNull(), // Hashed password for team login
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
  groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }), // Optional: null if group not assigned
  
  // League points (separate from match scores)
  leaguePoints: integer("league_points").notNull().default(0),
  bonusPoints: integer("bonus_points").notNull().default(0),

  // Triple Crown: Cup group points (separate from PL leaguePoints)
  cupGroupPoints: integer("cup_group_points").notNull().default(0),

  // Triple Crown: Ghost team marker
  isGhost: integer("is_ghost", { mode: "boolean" }).notNull().default(false),

  // JPL Auction: Economy tracking
  purse: integer("purse").notNull().default(0),
  totalSpent: integer("total_spent").notNull().default(0),
  totalRefunds: integer("total_refunds").notNull().default(0),
  totalIncome: integer("total_income").notNull().default(0),

  // JPL Auction: Penalty slots (missed nominations reduce max squad size from 14)
  penaltySlots: integer("penalty_slots").notNull().default(0),
  // JPL Auction: Bonus slots unlocked via purse purchase (0 = default 14-slot cap;
  // 1 = slot 15 unlocked for £10M; 2 = slot 16 unlocked for an additional £25M).
  // Locked-slot unlocks are only allowed after the initial auction completes.
  bonusSlots: integer("bonus_slots").notNull().default(0),
  
  // Chip tracking — Set 1 and Set 2 (boundaries vary by league variant, see league.playoffStartGw)
  // Existing chips: WW = Win-Win, DP = Double Pointer, CC = Challenge Chip
  // New chips:      SL = Score Lock, CB = Comeback, UD = Underdog
  doublePointerSet1Used: integer("double_pointer_set1_used", { mode: "boolean" }).notNull().default(false),
  challengeChipSet1Used: integer("challenge_chip_set1_used", { mode: "boolean" }).notNull().default(false),
  winWinSet1Used: integer("win_win_set1_used", { mode: "boolean" }).notNull().default(false),
  scoreLockSet1Used: integer("score_lock_set1_used", { mode: "boolean" }).notNull().default(false),
  comebackSet1Used: integer("comeback_set1_used", { mode: "boolean" }).notNull().default(false),
  underdogSet1Used: integer("underdog_set1_used", { mode: "boolean" }).notNull().default(false),
  doublePointerSet2Used: integer("double_pointer_set2_used", { mode: "boolean" }).notNull().default(false),
  challengeChipSet2Used: integer("challenge_chip_set2_used", { mode: "boolean" }).notNull().default(false),
  winWinSet2Used: integer("win_win_set2_used", { mode: "boolean" }).notNull().default(false),
  scoreLockSet2Used: integer("score_lock_set2_used", { mode: "boolean" }).notNull().default(false),
  comebackSet2Used: integer("comeback_set2_used", { mode: "boolean" }).notNull().default(false),
  underdogSet2Used: integer("underdog_set2_used", { mode: "boolean" }).notNull().default(false),

  // Team onboarding: set to true when team completes setup wizard (team name, 2 players)
  isProfileComplete: integer("is_profile_complete", { mode: "boolean" }).notNull().default(false),

  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  leagueNameUnique: uniqueIndex("teams_league_name_unique").on(table.leagueId, table.name),
  loginIdGlobalUnique: uniqueIndex("teams_login_id_global_unique").on(table.teamLoginId),
}));

// Player (each team has exactly 2 players)
export const players = sqliteTable("players", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  fplId: text("fpl_id").notNull(), // Official FPL Team ID for fetching scores
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  
  // Captaincy tracking (15 chips per player in League Stage)
  captaincyChipsUsed: integer("captaincy_chips_used").notNull().default(0),
  
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Gameweek (GW1 - GW38)
export const gameweeks = sqliteTable("gameweeks", {
  id: text("id").primaryKey(),
  number: integer("number").notNull(), // 1-38, unique per league
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  deadline: integer("deadline", { mode: "timestamp" }).notNull(),
  
  // Phase classification
  isPlayoffs: integer("is_playoffs", { mode: "boolean" }).notNull().default(false), // GW31-38 are playoffs
  
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  leagueNumberUnique: uniqueIndex("gameweeks_league_number_unique").on(table.leagueId, table.number),
}));

// Fixture (match between two teams)
export const fixtures = sqliteTable("fixtures", {
  id: text("id").primaryKey(),
  gameweekId: text("gameweek_id").notNull().references(() => gameweeks.id, { onDelete: "cascade" }),
  homeTeamId: text("home_team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  awayTeamId: text("away_team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  groupId: text("group_id").references(() => groups.id, { onDelete: "set null" }), // Optional: can be null if team has no group
  
  // Fixture type
  isChallenge: integer("is_challenge", { mode: "boolean" }).notNull().default(false), // Challenge Chip fixture
  isPlayoff: integer("is_playoff", { mode: "boolean" }).notNull().default(false), // Playoff fixture
  competitionType: text("competition_type"), // "pl" | "cup-group" | "ucl-knockout" | "uel-knockout" (Triple Crown)
  
  // Playoff-specific fields (null for league-phase fixtures)
  roundName: text("round_name"), // "RO16", "QF", "SF", "Final", "C-31", etc.
  leg: integer("leg"), // 1 or 2 for 2-legged ties; null for single-leg
  tieId: text("tie_id"), // Links to playoffTies.tieId
  roundType: text("round_type"), // "tvt" | "challenger-ko" | "challenger-survival"
  
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Result of a fixture
export const results = sqliteTable("results", {
  id: text("id").primaryKey(),
  fixtureId: text("fixture_id").notNull().unique().references(() => fixtures.id, { onDelete: "cascade" }),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  
  // Scores (combined FPL scores minus transfer hits)
  homeScore: integer("home_score").notNull(),
  awayScore: integer("away_score").notNull(),
  
  // Match points awarded (Win=2, Draw=1, Loss=0)
  homeMatchPoints: integer("home_match_points").notNull(),
  awayMatchPoints: integer("away_match_points").notNull(),
  
  // Bonus tracking
  homeGotBonus: integer("home_got_bonus", { mode: "boolean" }).notNull().default(false),
  awayGotBonus: integer("away_got_bonus", { mode: "boolean" }).notNull().default(false),
  
  // Chip usage
  homeUsedDoublePointer: integer("home_used_double_pointer", { mode: "boolean" }).notNull().default(false),
  awayUsedDoublePointer: integer("away_used_double_pointer", { mode: "boolean" }).notNull().default(false),

  // Per-player score breakdown stored as JSON (populated when gameweek is processed)
  // Shape: [{ name, fplId, fplScore, transferHits, isCaptain, finalScore }]
  homePlayerScores: text("home_player_scores"),
  awayPlayerScores: text("away_player_scores"),
  
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Captain selection per gameweek  
export const gameweekCaptains = sqliteTable("gameweek_captains", {
  id: text("id").primaryKey(),
  gameweekId: text("gameweek_id").notNull().references(() => gameweeks.id, { onDelete: "cascade" }),
  playerId: text("player_id").notNull().references(() => players.id, { onDelete: "cascade" }),
  
  // FPL scores for the captain
  fplScore: integer("fpl_score").notNull().default(0),
  transferHits: integer("transfer_hits").notNull().default(0),
  doubledScore: integer("doubled_score").notNull().default(0), // (fplScore - transferHits) * 2
  
  // Announcement tracking
  announcedAt: integer("announced_at", { mode: "timestamp" }),
  isValid: integer("is_valid", { mode: "boolean" }).notNull().default(true), // false if announced late or spammed
  
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// TVT Chip usage per gameweek
export const gameweekChips = sqliteTable("gameweek_chips", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  gameweekId: text("gameweek_id").notNull().references(() => gameweeks.id, { onDelete: "cascade" }),

  // Chip type: "W" = Win-Win, "D" = Double Pointer, "C" = Challenge,
  //            "SL" = Score Lock, "CB" = Comeback, "UD" = Underdog
  chipType: text("chip_type").notNull(), // "W" | "D" | "C" | "SL" | "CB" | "UD"

  // For Challenge Chip: the team being challenged (top-2 from opposite group)
  challengedTeamId: text("challenged_team_id").references(() => teams.id, { onDelete: "set null" }),
  
  // Validation status
  isValid: integer("is_valid", { mode: "boolean" }).notNull().default(true),
  validationErrors: text("validation_errors"), // JSON array of error messages
  
  // Processing status
  isProcessed: integer("is_processed", { mode: "boolean" }).notNull().default(false),
  pointsAwarded: integer("points_awarded").notNull().default(0),
  
  // For Win-Win: track if team had negative hits (chip wasted)
  hadNegativeHits: integer("had_negative_hits", { mode: "boolean" }).notNull().default(false),
  
  // For Double Pointer / Underdog: team's rank and opponent's rank at time of validation
  teamRankAtValidation: integer("team_rank_at_validation"),
  opponentRankAtValidation: integer("opponent_rank_at_validation"),

  // For Score Lock: the team's season average score at time of chip use (used as the floor)
  averageScoreAtUse: integer("average_score_at_use"),
  
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ============================================
// Playoff Tables
// ============================================

// Playoff ties — one row per matchup (links 2-legged or single-leg encounters)
export const playoffTies = sqliteTable("playoff_ties", {
  tieId: text("tie_id").primaryKey(), // e.g. "RO16-A", "C-31-A", "QF-B"
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  roundName: text("round_name").notNull(), // Display label: "RO16", "QF", "SF", "Final", "C-31", etc.
  roundType: text("round_type").notNull(), // "tvt" | "challenger-ko" | "challenger-survival"
  homeTeamId: text("home_team_id").references(() => teams.id, { onDelete: "set null" }),
  awayTeamId: text("away_team_id").references(() => teams.id, { onDelete: "set null" }),
  homeAggregate: integer("home_aggregate").notNull().default(0),
  awayAggregate: integer("away_aggregate").notNull().default(0),
  winnerId: text("winner_id").references(() => teams.id, { onDelete: "set null" }),
  loserId: text("loser_id").references(() => teams.id, { onDelete: "set null" }),
  gw1: integer("gw1").notNull(), // First leg / single-leg GW number
  gw2: integer("gw2"), // Second leg GW number (null for single-leg)
  gw3: integer("gw3"), // Third leg GW number (null for 1-leg/2-leg ties; used by 16T triple-leg Final/3rd)
  status: text("status").notNull().default("pending"), // "pending" | "leg1_done" | "leg2_done" | "complete"
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Challenger Survival entries (GW33) — individual team scores, not head-to-head
export const challengerSurvivalEntries = sqliteTable("challenger_survival_entries", {
  id: text("id").primaryKey(),
  gameweekId: text("gameweek_id").notNull().references(() => gameweeks.id, { onDelete: "cascade" }),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  score: integer("score").notNull().default(0),
  rank: integer("rank"),
  advanced: integer("advanced", { mode: "boolean" }).notNull().default(false),
  playerScores: text("player_scores"), // JSON: [{ name, fplId, fplScore, transferHits, isCaptain, isTempCaptain?, finalScore }]
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// League backups — JSON snapshots of teams/fixtures/captains/chips in importable shape.
// One row per (leagueId, trigger) combo when trigger="gw1-lock"; many rows allowed for "manual".
// JSON columns store ROW ARRAYS (not binary xlsx) so future formatting changes don't lock us in.
// Auction-specific columns: teams-state (purse/totalSpent/etc.), squads (auction_ownership rows),
// clubs (auction_club_ownership rows), gameweeks (so a fresh restore knows the GW shape).
export const backups = sqliteTable("backups", {
  id: text("id").primaryKey(),
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  trigger: text("trigger").notNull(), // "gw1-lock" | "manual" | "auction-complete"
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  teamsJson: text("teams_json"),       // null when format === "auction"
  fixturesJson: text("fixtures_json").notNull(),
  captainsJson: text("captains_json"), // null when format === "auction"
  chipsJson: text("chips_json"),       // null when format !== "tvt"
  // Auction format: per-team economy + squad + club snapshots. Populated only for auction leagues;
  // null for TVT/triple-crown. Restore reads these to rebuild ownership state then admins reprocess GWs.
  auctionTeamsStateJson: text("auction_teams_state_json"),
  auctionSquadsJson: text("auction_squads_json"),
  auctionClubsJson: text("auction_clubs_json"),
  // Gameweeks list — id/number/deadline/isPlayoffs — preserved so restore can recreate GW rows when
  // restoring into a fresh league (or repair missing GW rows).
  gameweeksJson: text("gameweeks_json"),
});

// Admin-configurable settings (key-value store, scoped per league)
export const settings = sqliteTable("settings", {
  key: text("key").notNull(),
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  pk: primaryKey({ columns: [table.key, table.leagueId] }),
}));

// Audit log for penalties and special events
export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(), // "PENALTY", "BONUS", "CHIP_USAGE", etc.
  description: text("description").notNull(),
  teamId: text("team_id"),
  gameweekId: text("gameweek_id"),
  pointsAffected: integer("points_affected").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// ============================================
// JPL Auction Tables
// ============================================

// Auction ownership — which PL player (FPL element) is owned by which team
export const auctionOwnership = sqliteTable("auction_ownership", {
  id: text("id").primaryKey(),
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  fplElementId: integer("fpl_element_id").notNull(), // FPL element ID (the actual PL player)
  playerName: text("player_name").notNull(), // Cached web_name from bootstrap
  elementType: integer("element_type"), // 1=GK, 2=DEF, 3=MID, 4=FWD — nullable for legacy records
  purchasePrice: integer("purchase_price").notNull(),
  acquiredGw: integer("acquired_gw").notNull(), // GW in which player was acquired (0 = pre-season)
  releasedGw: integer("released_gw"), // GW in which player was released (null if active)
  status: text("status").notNull().default("active"), // "active" | "deadwood" | "released"
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  activeOwnerUnique: uniqueIndex("auction_ownership_active_unique").on(table.leagueId, table.fplElementId),
}));

// Auction scores — per-GW team totals (replaces results for auction format)
// total_points = raw_points + synergy_bonus + club_result_bonus.
// `total_points` and `synergy_bonus` are REAL (synergy can be 0.5 × raw, naturally fractional).
// `raw_points` and `club_result_bonus` are always integer-valued but declared as integers.
// `player_breakdown` JSON: [{elementId, name, rawPoints, synergyBonus, plTeamId}]
// Legacy rows (pre-club-auction) may carry the older [{elementId, name, points}] shape; readers must tolerate both.
export const auctionScores = sqliteTable("auction_scores", {
  id: text("id").primaryKey(),
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  gameweekId: text("gameweek_id").notNull().references(() => gameweeks.id, { onDelete: "cascade" }),
  totalPoints: real("total_points").notNull(), // raw + synergy + clubResult; REAL because synergy can be fractional
  rawPoints: integer("raw_points").notNull().default(0),         // sum of owned players' raw FPL points this GW
  synergyBonus: real("synergy_bonus").notNull().default(0),       // 0.5 × raw on players matching team's owned PL club
  clubResultBonus: integer("club_result_bonus").notNull().default(0), // tier-based bonus per fixture this GW for owned club
  // Human-readable summary of the GW's owned-club result (e.g. "Brentford 3-0 Man Utd → +3").
  // Persisted at scoring time; null for legacy rows pre-club-auction.
  clubResultSummary: text("club_result_summary"),
  playerBreakdown: text("player_breakdown").notNull(),
  rank: integer("rank"), // GW rank (computed after all teams scored)
  payout: integer("payout").notNull().default(0), // Income earned this GW based on rank
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  teamGwUnique: uniqueIndex("auction_scores_team_gw_unique").on(table.leagueId, table.teamId, table.gameweekId),
}));

// PL Club ownership — one row per fantasy team that bought a PL club at the club auction.
// One club per team, one owner per club (per league). `plTeamName`/`plTeamShort` snapshotted at purchase
// so display survives FPL bootstrap drift. Tier resolved from `plStandingsConfig` at purchase time.
export const auctionClubOwnership = sqliteTable("auction_club_ownership", {
  id: text("id").primaryKey(),
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  plTeamId: integer("pl_team_id").notNull(),
  plTeamName: text("pl_team_name").notNull(),
  plTeamShort: text("pl_team_short").notNull(),
  tier: text("tier").notNull(), // "top8" | "mid" | "promoted"
  purchasePrice: integer("purchase_price").notNull(),
  acquiredAt: integer("acquired_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  oneClubPerTeam: uniqueIndex("auction_club_team_unique").on(table.leagueId, table.teamId),
  oneOwnerPerClub: uniqueIndex("auction_club_pl_unique").on(table.leagueId, table.plTeamId),
}));

// PL Standings config — singleton row (id = "current") describing the tier mapping the
// club auction uses. Top 8 + Mid (9-17) from last season's final ladder, Promoted = 3 clubs
// just up from the Championship. Superadmin-managed at /superadmin?tab=pl-standings.
export const plStandingsConfig = sqliteTable("pl_standings_config", {
  id: text("id").primaryKey(),
  season: text("season").notNull(), // e.g. "2025-26"
  top8: text("top8").notNull(),     // JSON array of FPL bootstrap team IDs (length 8)
  mid: text("mid").notNull(),       // JSON array (length 9)
  promoted: text("promoted").notNull(), // JSON array (length 3)
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Auction sessions — tracks auction windows (pausable/resumable, can span multiple days)
export const auctionSessions = sqliteTable("auction_sessions", {
  id: text("id").primaryKey(),
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // "initial" | "mini-auction"
  cycleNumber: integer("cycle_number").notNull().default(0), // 0=initial, 1/2/3 for 10-GW cycles
  status: text("status").notNull().default("pending"), // "pending" | "active" | "paused" | "completed"
  snakeOrder: text("snake_order").notNull().default("[]"), // JSON array of teamIds in nomination order
  currentNominatorIndex: integer("current_nominator_index").notNull().default(0),
  nominationDeadline: integer("nomination_deadline", { mode: "timestamp" }), // When current nominator must nominate by (null = no active deadline)
  scheduledAt: integer("scheduled_at", { mode: "timestamp" }), // When the auction is scheduled to start (shown to users as countdown)
  bidTimerSeconds: integer("bid_timer_seconds").notNull().default(20), // Seconds per bid round (admin-configurable)
  nominationTimeoutSeconds: integer("nomination_timeout_seconds").notNull().default(60), // Seconds to nominate (admin-configurable)
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Auction wishlists — priority-ordered player lists per team for auto-nomination
export const auctionWishlists = sqliteTable("auction_wishlists", {
  id: text("id").primaryKey(),
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  fplElementId: integer("fpl_element_id").notNull(),
  playerName: text("player_name").notNull(),
  priority: integer("priority").notNull(), // 1 = highest priority
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Auction bids — live auction item state per nomination
export const auctionBids = sqliteTable("auction_bids", {
  id: text("id").primaryKey(),
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => auctionSessions.id, { onDelete: "cascade" }),
  nominatorTeamId: text("nominator_team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  fplElementId: integer("fpl_element_id").notNull(),
  playerName: text("player_name").notNull(),
  currentHighBid: integer("current_high_bid").notNull(),
  currentHighBidderId: text("current_high_bidder_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  minBid: integer("min_bid").notNull(),
  status: text("status").notNull().default("open"), // "open" | "sold" | "unsold" | "cancelled"
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Auction bid logs — append-only event log for each bid lifecycle
export const auctionBidLogs = sqliteTable("auction_bid_logs", {
  id: text("id").primaryKey(),
  bidId: text("bid_id").notNull().references(() => auctionBids.id, { onDelete: "cascade" }),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  amount: integer("amount").notNull(),
  type: text("type").notNull(), // "nomination" | "bid" | "sold" | "unsold"
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Team penalties — per-row ledger of nomination-miss penalties so we can price
// each redemption based on whether the penalty's cycle has ended yet.
export const teamPenalties = sqliteTable("team_penalties", {
  id: text("id").primaryKey(),
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => auctionSessions.id, { onDelete: "set null" }),
  incurredCycle: integer("incurred_cycle").notNull(), // cycleNumber of the session that issued the penalty
  redeemedAt: integer("redeemed_at", { mode: "timestamp" }), // null = not yet redeemed
  redemptionPrice: integer("redemption_price"), // price paid at redemption (null until redeemed)
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Trade proposals — P2P marketplace with veto system
export const tradeProposals = sqliteTable("trade_proposals", {
  id: text("id").primaryKey(),
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  proposerTeamId: text("proposer_team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  targetTeamId: text("target_team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  offeredPlayerIds: text("offered_player_ids").notNull().default("[]"), // JSON array of auctionOwnership IDs
  requestedPlayerIds: text("requested_player_ids").notNull().default("[]"), // JSON array of auctionOwnership IDs
  cashOffered: integer("cash_offered").notNull().default(0), // Positive = proposer pays target, negative = target pays
  status: text("status").notNull().default("pending"), // "pending" | "accepted" | "rejected" | "vetoed" | "expired"
  vetoDeadline: integer("veto_deadline", { mode: "timestamp" }),
  vetoVotes: text("veto_votes").notNull().default("{}"), // JSON: {teamId: "veto" | "approve"}
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Notifications — per-team in-app notifications (trade lifecycle, etc.)
export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  leagueId: text("league_id").notNull().references(() => leagues.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // "trade_proposed" | "trade_accepted" | "trade_rejected" | "trade_approved" | "trade_admin_rejected"
  title: text("title").notNull(),
  body: text("body").notNull(),
  link: text("link"),
  readAt: integer("read_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  teamUnread: index("notifications_team_unread").on(table.teamId, table.readAt),
}));

// ============================================
// Relations
// ============================================

export const leaguesRelations = relations(leagues, ({ many }) => ({
  admins: many(leagueAdmins),
  groups: many(groups),
  teams: many(teams),
  gameweeks: many(gameweeks),
  playoffTies: many(playoffTies),
  auctionOwnerships: many(auctionOwnership),
  auctionScores: many(auctionScores),
  auctionSessions: many(auctionSessions),
  auctionBids: many(auctionBids),
  auctionWishlists: many(auctionWishlists),
  auctionClubOwnerships: many(auctionClubOwnership),
  tradeProposals: many(tradeProposals),
}));

export const leagueAdminsRelations = relations(leagueAdmins, ({ one }) => ({
  league: one(leagues, {
    fields: [leagueAdmins.leagueId],
    references: [leagues.id],
  }),
  user: one(users, {
    fields: [leagueAdmins.userId],
    references: [users.id],
  }),
}));

// Users are now admin-only, no team relation needed

export const groupsRelations = relations(groups, ({ one, many }) => ({
  league: one(leagues, {
    fields: [groups.leagueId],
    references: [leagues.id],
  }),
  teams: many(teams),
  fixtures: many(fixtures),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  league: one(leagues, {
    fields: [teams.leagueId],
    references: [leagues.id],
  }),
  group: one(groups, {
    fields: [teams.groupId],
    references: [groups.id],
  }),
  players: many(players),
  homeFixtures: many(fixtures, { relationName: "homeTeam" }),
  awayFixtures: many(fixtures, { relationName: "awayTeam" }),
  results: many(results),
  chips: many(gameweekChips, { relationName: "teamChips" }),
  challengedChips: many(gameweekChips, { relationName: "challengedTeamChips" }),
  auctionOwnerships: many(auctionOwnership),
  auctionScores: many(auctionScores),
  auctionWishlists: many(auctionWishlists),
  auctionClubOwnership: many(auctionClubOwnership),
}));

export const playersRelations = relations(players, ({ one, many }) => ({
  team: one(teams, {
    fields: [players.teamId],
    references: [teams.id],
  }),
  captainedIn: many(gameweekCaptains),
}));

export const gameweeksRelations = relations(gameweeks, ({ one, many }) => ({
  league: one(leagues, {
    fields: [gameweeks.leagueId],
    references: [leagues.id],
  }),
  fixtures: many(fixtures),
  captains: many(gameweekCaptains),
  chips: many(gameweekChips),
}));

export const fixturesRelations = relations(fixtures, ({ one }) => ({
  gameweek: one(gameweeks, {
    fields: [fixtures.gameweekId],
    references: [gameweeks.id],
  }),
  homeTeam: one(teams, {
    fields: [fixtures.homeTeamId],
    references: [teams.id],
    relationName: "homeTeam",
  }),
  awayTeam: one(teams, {
    fields: [fixtures.awayTeamId],
    references: [teams.id],
    relationName: "awayTeam",
  }),
  group: one(groups, {
    fields: [fixtures.groupId],
    references: [groups.id],
  }),
  result: one(results),
}));

export const resultsRelations = relations(results, ({ one }) => ({
  fixture: one(fixtures, {
    fields: [results.fixtureId],
    references: [fixtures.id],
  }),
  team: one(teams, {
    fields: [results.teamId],
    references: [teams.id],
  }),
}));

export const gameweekCaptainsRelations = relations(gameweekCaptains, ({ one }) => ({
  gameweek: one(gameweeks, {
    fields: [gameweekCaptains.gameweekId],
    references: [gameweeks.id],
  }),
  player: one(players, {
    fields: [gameweekCaptains.playerId],
    references: [players.id],
  }),
}));

export const playoffTiesRelations = relations(playoffTies, ({ one }) => ({
  league: one(leagues, {
    fields: [playoffTies.leagueId],
    references: [leagues.id],
  }),
  homeTeam: one(teams, {
    fields: [playoffTies.homeTeamId],
    references: [teams.id],
    relationName: "homeTie",
  }),
  awayTeam: one(teams, {
    fields: [playoffTies.awayTeamId],
    references: [teams.id],
    relationName: "awayTie",
  }),
  winner: one(teams, {
    fields: [playoffTies.winnerId],
    references: [teams.id],
    relationName: "wonTie",
  }),
  loser: one(teams, {
    fields: [playoffTies.loserId],
    references: [teams.id],
    relationName: "lostTie",
  }),
}));

export const challengerSurvivalRelations = relations(challengerSurvivalEntries, ({ one }) => ({
  gameweek: one(gameweeks, {
    fields: [challengerSurvivalEntries.gameweekId],
    references: [gameweeks.id],
  }),
  team: one(teams, {
    fields: [challengerSurvivalEntries.teamId],
    references: [teams.id],
  }),
}));

export const gameweekChipsRelations = relations(gameweekChips, ({ one }) => ({
  team: one(teams, {
    fields: [gameweekChips.teamId],
    references: [teams.id],
    relationName: "teamChips",
  }),
  gameweek: one(gameweeks, {
    fields: [gameweekChips.gameweekId],
    references: [gameweeks.id],
  }),
  challengedTeam: one(teams, {
    fields: [gameweekChips.challengedTeamId],
    references: [teams.id],
    relationName: "challengedTeamChips",
  }),
}));

// ============================================
// JPL Auction Relations
// ============================================

export const auctionOwnershipRelations = relations(auctionOwnership, ({ one }) => ({
  league: one(leagues, {
    fields: [auctionOwnership.leagueId],
    references: [leagues.id],
  }),
  team: one(teams, {
    fields: [auctionOwnership.teamId],
    references: [teams.id],
  }),
}));

export const auctionScoresRelations = relations(auctionScores, ({ one }) => ({
  league: one(leagues, {
    fields: [auctionScores.leagueId],
    references: [leagues.id],
  }),
  team: one(teams, {
    fields: [auctionScores.teamId],
    references: [teams.id],
  }),
  gameweek: one(gameweeks, {
    fields: [auctionScores.gameweekId],
    references: [gameweeks.id],
  }),
}));

export const auctionSessionsRelations = relations(auctionSessions, ({ one, many }) => ({
  league: one(leagues, {
    fields: [auctionSessions.leagueId],
    references: [leagues.id],
  }),
  bids: many(auctionBids),
}));

export const auctionBidsRelations = relations(auctionBids, ({ one }) => ({
  league: one(leagues, {
    fields: [auctionBids.leagueId],
    references: [leagues.id],
  }),
  session: one(auctionSessions, {
    fields: [auctionBids.sessionId],
    references: [auctionSessions.id],
  }),
  nominator: one(teams, {
    fields: [auctionBids.nominatorTeamId],
    references: [teams.id],
    relationName: "nominatedBids",
  }),
  highBidder: one(teams, {
    fields: [auctionBids.currentHighBidderId],
    references: [teams.id],
    relationName: "wonBids",
  }),
}));

export const auctionClubOwnershipRelations = relations(auctionClubOwnership, ({ one }) => ({
  league: one(leagues, {
    fields: [auctionClubOwnership.leagueId],
    references: [leagues.id],
  }),
  team: one(teams, {
    fields: [auctionClubOwnership.teamId],
    references: [teams.id],
  }),
}));

export const tradeProposalsRelations = relations(tradeProposals, ({ one }) => ({
  league: one(leagues, {
    fields: [tradeProposals.leagueId],
    references: [leagues.id],
  }),
  proposer: one(teams, {
    fields: [tradeProposals.proposerTeamId],
    references: [teams.id],
    relationName: "proposedTrades",
  }),
  target: one(teams, {
    fields: [tradeProposals.targetTeamId],
    references: [teams.id],
    relationName: "receivedTrades",
  }),
}));

// ============================================
// Type Exports (use these instead of Prisma types)
// ============================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;

export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;

export type Gameweek = typeof gameweeks.$inferSelect;
export type NewGameweek = typeof gameweeks.$inferInsert;

export type Fixture = typeof fixtures.$inferSelect;
export type NewFixture = typeof fixtures.$inferInsert;

export type Result = typeof results.$inferSelect;
export type NewResult = typeof results.$inferInsert;

export type GameweekCaptain = typeof gameweekCaptains.$inferSelect;
export type NewGameweekCaptain = typeof gameweekCaptains.$inferInsert;

export type GameweekChip = typeof gameweekChips.$inferSelect;
export type NewGameweekChip = typeof gameweekChips.$inferInsert;

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;

export type League = typeof leagues.$inferSelect;
export type NewLeague = typeof leagues.$inferInsert;

export type LeagueAdmin = typeof leagueAdmins.$inferSelect;
export type NewLeagueAdmin = typeof leagueAdmins.$inferInsert;

export type AuctionOwnership = typeof auctionOwnership.$inferSelect;
export type NewAuctionOwnership = typeof auctionOwnership.$inferInsert;

export type AuctionScore = typeof auctionScores.$inferSelect;
export type NewAuctionScore = typeof auctionScores.$inferInsert;

export type AuctionSession = typeof auctionSessions.$inferSelect;
export type NewAuctionSession = typeof auctionSessions.$inferInsert;

export type AuctionBid = typeof auctionBids.$inferSelect;
export type NewAuctionBid = typeof auctionBids.$inferInsert;

export type TradeProposal = typeof tradeProposals.$inferSelect;
export type NewTradeProposal = typeof tradeProposals.$inferInsert;

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

export type AuctionClubOwnership = typeof auctionClubOwnership.$inferSelect;
export type NewAuctionClubOwnership = typeof auctionClubOwnership.$inferInsert;

export type PLStandingsConfig = typeof plStandingsConfig.$inferSelect;
export type NewPLStandingsConfig = typeof plStandingsConfig.$inferInsert;

// Tier discriminator for PL Club Auction
export type ClubTier = "top8" | "mid" | "promoted";
