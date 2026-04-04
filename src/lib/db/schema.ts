import { sqliteTable, text, integer, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";
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

  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Maps non-superadmin users to leagues they can administer
export const leagueAdmins = sqliteTable("league_admins", {
  id: text("id").primaryKey(),
  leagueId: text("league_id").notNull().references(() => leagues.id),
  userId: text("user_id").notNull().references(() => users.id),
}, (table) => ({
  leagueUserUnique: uniqueIndex("league_admins_league_user_unique").on(table.leagueId, table.userId),
}));

// Group (A or B for TVT; Cup-A/B/C/D for Triple Crown)
export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  leagueId: text("league_id").notNull().references(() => leagues.id),
  groupType: text("group_type").default("pl"), // "pl" | "cup" (Triple Crown uses "cup" for cup groups)
}, (table) => ({
  leagueNameUnique: uniqueIndex("groups_league_name_unique").on(table.leagueId, table.name),
}));

// Team (2 players per team) - also acts as login account
export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(), // Team name used as login ID
  leagueId: text("league_id").notNull().references(() => leagues.id),
  abbreviation: text("abbreviation").notNull(), // e.g., "DM"
  password: text("password").notNull(), // Hashed password for team login
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
  groupId: text("group_id").notNull().references(() => groups.id),
  
  // League points (separate from match scores)
  leaguePoints: integer("league_points").notNull().default(0),
  bonusPoints: integer("bonus_points").notNull().default(0),

  // Triple Crown: Cup group points (separate from PL leaguePoints)
  cupGroupPoints: integer("cup_group_points").notNull().default(0),

  // Triple Crown: Ghost team marker
  isGhost: integer("is_ghost", { mode: "boolean" }).notNull().default(false),
  
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
  
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  leagueNameUnique: uniqueIndex("teams_league_name_unique").on(table.leagueId, table.name),
}));

// Player (each team has exactly 2 players)
export const players = sqliteTable("players", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  fplId: text("fpl_id").notNull(), // Official FPL Team ID for fetching scores
  teamId: text("team_id").notNull().references(() => teams.id),
  
  // Captaincy tracking (15 chips per player in League Stage)
  captaincyChipsUsed: integer("captaincy_chips_used").notNull().default(0),
  
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Gameweek (GW1 - GW38)
export const gameweeks = sqliteTable("gameweeks", {
  id: text("id").primaryKey(),
  number: integer("number").notNull(), // 1-38, unique per league
  leagueId: text("league_id").notNull().references(() => leagues.id),
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
  gameweekId: text("gameweek_id").notNull().references(() => gameweeks.id),
  homeTeamId: text("home_team_id").notNull().references(() => teams.id),
  awayTeamId: text("away_team_id").notNull().references(() => teams.id),
  groupId: text("group_id").notNull().references(() => groups.id),
  
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
  fixtureId: text("fixture_id").notNull().unique().references(() => fixtures.id),
  teamId: text("team_id").notNull().references(() => teams.id),
  
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
  gameweekId: text("gameweek_id").notNull().references(() => gameweeks.id),
  playerId: text("player_id").notNull().references(() => players.id),
  
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
  teamId: text("team_id").notNull().references(() => teams.id),
  gameweekId: text("gameweek_id").notNull().references(() => gameweeks.id),
  
  // Chip type: "W" = Win-Win, "D" = Double Pointer, "C" = Challenge,
  //            "SL" = Score Lock, "CB" = Comeback, "UD" = Underdog
  chipType: text("chip_type").notNull(), // "W" | "D" | "C" | "SL" | "CB" | "UD"
  
  // For Challenge Chip: the team being challenged (top-2 from opposite group)
  challengedTeamId: text("challenged_team_id").references(() => teams.id),
  
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
  leagueId: text("league_id").notNull().references(() => leagues.id),
  roundName: text("round_name").notNull(), // Display label: "RO16", "QF", "SF", "Final", "C-31", etc.
  roundType: text("round_type").notNull(), // "tvt" | "challenger-ko" | "challenger-survival"
  homeTeamId: text("home_team_id").references(() => teams.id),
  awayTeamId: text("away_team_id").references(() => teams.id),
  homeAggregate: integer("home_aggregate").notNull().default(0),
  awayAggregate: integer("away_aggregate").notNull().default(0),
  winnerId: text("winner_id").references(() => teams.id),
  loserId: text("loser_id").references(() => teams.id),
  gw1: integer("gw1").notNull(), // First leg / single-leg GW number
  gw2: integer("gw2"), // Second leg GW number (null for single-leg)
  status: text("status").notNull().default("pending"), // "pending" | "leg1_done" | "complete"
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Challenger Survival entries (GW33) — individual team scores, not head-to-head
export const challengerSurvivalEntries = sqliteTable("challenger_survival_entries", {
  id: text("id").primaryKey(),
  gameweekId: text("gameweek_id").notNull().references(() => gameweeks.id),
  teamId: text("team_id").notNull().references(() => teams.id),
  score: integer("score").notNull().default(0),
  rank: integer("rank"),
  advanced: integer("advanced", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Admin-configurable settings (key-value store, scoped per league)
export const settings = sqliteTable("settings", {
  key: text("key").notNull(),
  leagueId: text("league_id").notNull().references(() => leagues.id),
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
// Relations
// ============================================

export const leaguesRelations = relations(leagues, ({ many }) => ({
  admins: many(leagueAdmins),
  groups: many(groups),
  teams: many(teams),
  gameweeks: many(gameweeks),
  playoffTies: many(playoffTies),
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
