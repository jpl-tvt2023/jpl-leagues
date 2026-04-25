CREATE TABLE `auction_bid_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`bid_id` text NOT NULL,
	`team_id` text NOT NULL,
	`amount` integer NOT NULL,
	`type` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bid_id`) REFERENCES `auction_bids`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `auction_wishlists` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`team_id` text NOT NULL,
	`fpl_element_id` integer NOT NULL,
	`player_name` text NOT NULL,
	`priority` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`league_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`link` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_team_unread` ON `notifications` (`team_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `team_penalties` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`team_id` text NOT NULL,
	`session_id` text,
	`incurred_cycle` integer NOT NULL,
	`redeemed_at` integer,
	`redemption_price` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `auction_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_auction_bids` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`session_id` text NOT NULL,
	`nominator_team_id` text NOT NULL,
	`fpl_element_id` integer NOT NULL,
	`player_name` text NOT NULL,
	`current_high_bid` integer NOT NULL,
	`current_high_bidder_id` text NOT NULL,
	`min_bid` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `auction_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`nominator_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`current_high_bidder_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_auction_bids`("id", "league_id", "session_id", "nominator_team_id", "fpl_element_id", "player_name", "current_high_bid", "current_high_bidder_id", "min_bid", "status", "expires_at", "created_at", "updated_at") SELECT "id", "league_id", "session_id", "nominator_team_id", "fpl_element_id", "player_name", "current_high_bid", "current_high_bidder_id", "min_bid", "status", "expires_at", "created_at", "updated_at" FROM `auction_bids`;--> statement-breakpoint
DROP TABLE `auction_bids`;--> statement-breakpoint
ALTER TABLE `__new_auction_bids` RENAME TO `auction_bids`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_auction_ownership` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`team_id` text NOT NULL,
	`fpl_element_id` integer NOT NULL,
	`player_name` text NOT NULL,
	`element_type` integer,
	`purchase_price` integer NOT NULL,
	`acquired_gw` integer NOT NULL,
	`released_gw` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_auction_ownership`("id", "league_id", "team_id", "fpl_element_id", "player_name", "element_type", "purchase_price", "acquired_gw", "released_gw", "status", "created_at", "updated_at") SELECT "id", "league_id", "team_id", "fpl_element_id", "player_name", "element_type", "purchase_price", "acquired_gw", "released_gw", "status", "created_at", "updated_at" FROM `auction_ownership`;--> statement-breakpoint
DROP TABLE `auction_ownership`;--> statement-breakpoint
ALTER TABLE `__new_auction_ownership` RENAME TO `auction_ownership`;--> statement-breakpoint
CREATE UNIQUE INDEX `auction_ownership_active_unique` ON `auction_ownership` (`league_id`,`fpl_element_id`);--> statement-breakpoint
CREATE TABLE `__new_auction_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`team_id` text NOT NULL,
	`gameweek_id` text NOT NULL,
	`total_points` integer NOT NULL,
	`player_breakdown` text NOT NULL,
	`rank` integer,
	`payout` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`gameweek_id`) REFERENCES `gameweeks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_auction_scores`("id", "league_id", "team_id", "gameweek_id", "total_points", "player_breakdown", "rank", "payout", "created_at") SELECT "id", "league_id", "team_id", "gameweek_id", "total_points", "player_breakdown", "rank", "payout", "created_at" FROM `auction_scores`;--> statement-breakpoint
DROP TABLE `auction_scores`;--> statement-breakpoint
ALTER TABLE `__new_auction_scores` RENAME TO `auction_scores`;--> statement-breakpoint
CREATE UNIQUE INDEX `auction_scores_team_gw_unique` ON `auction_scores` (`league_id`,`team_id`,`gameweek_id`);--> statement-breakpoint
CREATE TABLE `__new_auction_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`type` text NOT NULL,
	`cycle_number` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`snake_order` text DEFAULT '[]' NOT NULL,
	`current_nominator_index` integer DEFAULT 0 NOT NULL,
	`nomination_deadline` integer,
	`scheduled_at` integer,
	`bid_timer_seconds` integer DEFAULT 20 NOT NULL,
	`nomination_timeout_seconds` integer DEFAULT 60 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_auction_sessions`("id", "league_id", "type", "cycle_number", "status", "snake_order", "current_nominator_index", "nomination_deadline", "scheduled_at", "bid_timer_seconds", "nomination_timeout_seconds", "created_at") SELECT "id", "league_id", "type", "cycle_number", "status", "snake_order", "current_nominator_index", "nomination_deadline", "scheduled_at", "bid_timer_seconds", "nomination_timeout_seconds", "created_at" FROM `auction_sessions`;--> statement-breakpoint
DROP TABLE `auction_sessions`;--> statement-breakpoint
ALTER TABLE `__new_auction_sessions` RENAME TO `auction_sessions`;--> statement-breakpoint
CREATE TABLE `__new_challenger_survival_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`gameweek_id` text NOT NULL,
	`team_id` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`rank` integer,
	`advanced` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`gameweek_id`) REFERENCES `gameweeks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_challenger_survival_entries`("id", "gameweek_id", "team_id", "score", "rank", "advanced", "created_at") SELECT "id", "gameweek_id", "team_id", "score", "rank", "advanced", "created_at" FROM `challenger_survival_entries`;--> statement-breakpoint
DROP TABLE `challenger_survival_entries`;--> statement-breakpoint
ALTER TABLE `__new_challenger_survival_entries` RENAME TO `challenger_survival_entries`;--> statement-breakpoint
CREATE TABLE `__new_fixtures` (
	`id` text PRIMARY KEY NOT NULL,
	`gameweek_id` text NOT NULL,
	`home_team_id` text NOT NULL,
	`away_team_id` text NOT NULL,
	`group_id` text,
	`is_challenge` integer DEFAULT false NOT NULL,
	`is_playoff` integer DEFAULT false NOT NULL,
	`competition_type` text,
	`round_name` text,
	`leg` integer,
	`tie_id` text,
	`round_type` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`gameweek_id`) REFERENCES `gameweeks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`home_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`away_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_fixtures`("id", "gameweek_id", "home_team_id", "away_team_id", "group_id", "is_challenge", "is_playoff", "competition_type", "round_name", "leg", "tie_id", "round_type", "created_at", "updated_at") SELECT "id", "gameweek_id", "home_team_id", "away_team_id", "group_id", "is_challenge", "is_playoff", "competition_type", "round_name", "leg", "tie_id", "round_type", "created_at", "updated_at" FROM `fixtures`;--> statement-breakpoint
DROP TABLE `fixtures`;--> statement-breakpoint
ALTER TABLE `__new_fixtures` RENAME TO `fixtures`;--> statement-breakpoint
CREATE TABLE `__new_gameweek_captains` (
	`id` text PRIMARY KEY NOT NULL,
	`gameweek_id` text NOT NULL,
	`player_id` text NOT NULL,
	`fpl_score` integer DEFAULT 0 NOT NULL,
	`transfer_hits` integer DEFAULT 0 NOT NULL,
	`doubled_score` integer DEFAULT 0 NOT NULL,
	`announced_at` integer,
	`is_valid` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`gameweek_id`) REFERENCES `gameweeks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_gameweek_captains`("id", "gameweek_id", "player_id", "fpl_score", "transfer_hits", "doubled_score", "announced_at", "is_valid", "created_at", "updated_at") SELECT "id", "gameweek_id", "player_id", "fpl_score", "transfer_hits", "doubled_score", "announced_at", "is_valid", "created_at", "updated_at" FROM `gameweek_captains`;--> statement-breakpoint
DROP TABLE `gameweek_captains`;--> statement-breakpoint
ALTER TABLE `__new_gameweek_captains` RENAME TO `gameweek_captains`;--> statement-breakpoint
CREATE TABLE `__new_gameweek_chips` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`gameweek_id` text NOT NULL,
	`chip_type` text NOT NULL,
	`challenged_team_id` text,
	`is_valid` integer DEFAULT true NOT NULL,
	`validation_errors` text,
	`is_processed` integer DEFAULT false NOT NULL,
	`points_awarded` integer DEFAULT 0 NOT NULL,
	`had_negative_hits` integer DEFAULT false NOT NULL,
	`team_rank_at_validation` integer,
	`opponent_rank_at_validation` integer,
	`average_score_at_use` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`gameweek_id`) REFERENCES `gameweeks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`challenged_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_gameweek_chips`("id", "team_id", "gameweek_id", "chip_type", "challenged_team_id", "is_valid", "validation_errors", "is_processed", "points_awarded", "had_negative_hits", "team_rank_at_validation", "opponent_rank_at_validation", "average_score_at_use", "created_at", "updated_at") SELECT "id", "team_id", "gameweek_id", "chip_type", "challenged_team_id", "is_valid", "validation_errors", "is_processed", "points_awarded", "had_negative_hits", "team_rank_at_validation", "opponent_rank_at_validation", "average_score_at_use", "created_at", "updated_at" FROM `gameweek_chips`;--> statement-breakpoint
DROP TABLE `gameweek_chips`;--> statement-breakpoint
ALTER TABLE `__new_gameweek_chips` RENAME TO `gameweek_chips`;--> statement-breakpoint
CREATE TABLE `__new_gameweeks` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`league_id` text NOT NULL,
	`deadline` integer NOT NULL,
	`is_playoffs` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_gameweeks`("id", "number", "league_id", "deadline", "is_playoffs", "created_at", "updated_at") SELECT "id", "number", "league_id", "deadline", "is_playoffs", "created_at", "updated_at" FROM `gameweeks`;--> statement-breakpoint
DROP TABLE `gameweeks`;--> statement-breakpoint
ALTER TABLE `__new_gameweeks` RENAME TO `gameweeks`;--> statement-breakpoint
CREATE UNIQUE INDEX `gameweeks_league_number_unique` ON `gameweeks` (`league_id`,`number`);--> statement-breakpoint
CREATE TABLE `__new_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`league_id` text NOT NULL,
	`group_type` text DEFAULT 'pl',
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_groups`("id", "name", "league_id", "group_type") SELECT "id", "name", "league_id", "group_type" FROM `groups`;--> statement-breakpoint
DROP TABLE `groups`;--> statement-breakpoint
ALTER TABLE `__new_groups` RENAME TO `groups`;--> statement-breakpoint
CREATE UNIQUE INDEX `groups_league_name_unique` ON `groups` (`league_id`,`name`);--> statement-breakpoint
CREATE TABLE `__new_league_admins` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_league_admins`("id", "league_id", "user_id") SELECT "id", "league_id", "user_id" FROM `league_admins`;--> statement-breakpoint
DROP TABLE `league_admins`;--> statement-breakpoint
ALTER TABLE `__new_league_admins` RENAME TO `league_admins`;--> statement-breakpoint
CREATE UNIQUE INDEX `league_admins_league_user_unique` ON `league_admins` (`league_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `__new_players` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`fpl_id` text NOT NULL,
	`team_id` text NOT NULL,
	`captaincy_chips_used` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_players`("id", "name", "fpl_id", "team_id", "captaincy_chips_used", "created_at", "updated_at") SELECT "id", "name", "fpl_id", "team_id", "captaincy_chips_used", "created_at", "updated_at" FROM `players`;--> statement-breakpoint
DROP TABLE `players`;--> statement-breakpoint
ALTER TABLE `__new_players` RENAME TO `players`;--> statement-breakpoint
CREATE TABLE `__new_playoff_ties` (
	`tie_id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`round_name` text NOT NULL,
	`round_type` text NOT NULL,
	`home_team_id` text,
	`away_team_id` text,
	`home_aggregate` integer DEFAULT 0 NOT NULL,
	`away_aggregate` integer DEFAULT 0 NOT NULL,
	`winner_id` text,
	`loser_id` text,
	`gw1` integer NOT NULL,
	`gw2` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`home_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`away_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`winner_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`loser_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_playoff_ties`("tie_id", "league_id", "round_name", "round_type", "home_team_id", "away_team_id", "home_aggregate", "away_aggregate", "winner_id", "loser_id", "gw1", "gw2", "status", "created_at") SELECT "tie_id", "league_id", "round_name", "round_type", "home_team_id", "away_team_id", "home_aggregate", "away_aggregate", "winner_id", "loser_id", "gw1", "gw2", "status", "created_at" FROM `playoff_ties`;--> statement-breakpoint
DROP TABLE `playoff_ties`;--> statement-breakpoint
ALTER TABLE `__new_playoff_ties` RENAME TO `playoff_ties`;--> statement-breakpoint
CREATE TABLE `__new_results` (
	`id` text PRIMARY KEY NOT NULL,
	`fixture_id` text NOT NULL,
	`team_id` text NOT NULL,
	`home_score` integer NOT NULL,
	`away_score` integer NOT NULL,
	`home_match_points` integer NOT NULL,
	`away_match_points` integer NOT NULL,
	`home_got_bonus` integer DEFAULT false NOT NULL,
	`away_got_bonus` integer DEFAULT false NOT NULL,
	`home_used_double_pointer` integer DEFAULT false NOT NULL,
	`away_used_double_pointer` integer DEFAULT false NOT NULL,
	`home_player_scores` text,
	`away_player_scores` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_results`("id", "fixture_id", "team_id", "home_score", "away_score", "home_match_points", "away_match_points", "home_got_bonus", "away_got_bonus", "home_used_double_pointer", "away_used_double_pointer", "home_player_scores", "away_player_scores", "created_at", "updated_at") SELECT "id", "fixture_id", "team_id", "home_score", "away_score", "home_match_points", "away_match_points", "home_got_bonus", "away_got_bonus", "home_used_double_pointer", "away_used_double_pointer", "home_player_scores", "away_player_scores", "created_at", "updated_at" FROM `results`;--> statement-breakpoint
DROP TABLE `results`;--> statement-breakpoint
ALTER TABLE `__new_results` RENAME TO `results`;--> statement-breakpoint
CREATE UNIQUE INDEX `results_fixture_id_unique` ON `results` (`fixture_id`);--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`key` text NOT NULL,
	`league_id` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`key`, `league_id`),
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_settings`("key", "league_id", "value", "updated_at") SELECT "key", "league_id", "value", "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
CREATE TABLE `__new_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`team_login_id` text,
	`name` text NOT NULL,
	`league_id` text NOT NULL,
	`abbreviation` text NOT NULL,
	`password` text NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`group_id` text,
	`league_points` integer DEFAULT 0 NOT NULL,
	`bonus_points` integer DEFAULT 0 NOT NULL,
	`cup_group_points` integer DEFAULT 0 NOT NULL,
	`is_ghost` integer DEFAULT false NOT NULL,
	`purse` integer DEFAULT 0 NOT NULL,
	`total_spent` integer DEFAULT 0 NOT NULL,
	`total_refunds` integer DEFAULT 0 NOT NULL,
	`total_income` integer DEFAULT 0 NOT NULL,
	`penalty_slots` integer DEFAULT 0 NOT NULL,
	`double_pointer_set1_used` integer DEFAULT false NOT NULL,
	`challenge_chip_set1_used` integer DEFAULT false NOT NULL,
	`win_win_set1_used` integer DEFAULT false NOT NULL,
	`score_lock_set1_used` integer DEFAULT false NOT NULL,
	`comeback_set1_used` integer DEFAULT false NOT NULL,
	`underdog_set1_used` integer DEFAULT false NOT NULL,
	`double_pointer_set2_used` integer DEFAULT false NOT NULL,
	`challenge_chip_set2_used` integer DEFAULT false NOT NULL,
	`win_win_set2_used` integer DEFAULT false NOT NULL,
	`score_lock_set2_used` integer DEFAULT false NOT NULL,
	`comeback_set2_used` integer DEFAULT false NOT NULL,
	`underdog_set2_used` integer DEFAULT false NOT NULL,
	`is_profile_complete` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_teams`("id", "team_login_id", "name", "league_id", "abbreviation", "password", "must_change_password", "group_id", "league_points", "bonus_points", "cup_group_points", "is_ghost", "purse", "total_spent", "total_refunds", "total_income", "penalty_slots", "double_pointer_set1_used", "challenge_chip_set1_used", "win_win_set1_used", "score_lock_set1_used", "comeback_set1_used", "underdog_set1_used", "double_pointer_set2_used", "challenge_chip_set2_used", "win_win_set2_used", "score_lock_set2_used", "comeback_set2_used", "underdog_set2_used", "is_profile_complete", "created_at", "updated_at") SELECT "id", "team_login_id", "name", "league_id", "abbreviation", "password", "must_change_password", "group_id", "league_points", "bonus_points", "cup_group_points", "is_ghost", "purse", "total_spent", "total_refunds", "total_income", "penalty_slots", "double_pointer_set1_used", "challenge_chip_set1_used", "win_win_set1_used", "score_lock_set1_used", "comeback_set1_used", "underdog_set1_used", "double_pointer_set2_used", "challenge_chip_set2_used", "win_win_set2_used", "score_lock_set2_used", "comeback_set2_used", "underdog_set2_used", "is_profile_complete", "created_at", "updated_at" FROM `teams`;--> statement-breakpoint
DROP TABLE `teams`;--> statement-breakpoint
ALTER TABLE `__new_teams` RENAME TO `teams`;--> statement-breakpoint
CREATE UNIQUE INDEX `teams_league_name_unique` ON `teams` (`league_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `teams_login_id_global_unique` ON `teams` (`team_login_id`);--> statement-breakpoint
CREATE TABLE `__new_trade_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`proposer_team_id` text NOT NULL,
	`target_team_id` text NOT NULL,
	`offered_player_ids` text DEFAULT '[]' NOT NULL,
	`requested_player_ids` text DEFAULT '[]' NOT NULL,
	`cash_offered` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`veto_deadline` integer,
	`veto_votes` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposer_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_trade_proposals`("id", "league_id", "proposer_team_id", "target_team_id", "offered_player_ids", "requested_player_ids", "cash_offered", "status", "veto_deadline", "veto_votes", "created_at", "updated_at") SELECT "id", "league_id", "proposer_team_id", "target_team_id", "offered_player_ids", "requested_player_ids", "cash_offered", "status", "veto_deadline", "veto_votes", "created_at", "updated_at" FROM `trade_proposals`;--> statement-breakpoint
DROP TABLE `trade_proposals`;--> statement-breakpoint
ALTER TABLE `__new_trade_proposals` RENAME TO `trade_proposals`;--> statement-breakpoint
ALTER TABLE `leagues` ADD `is_simulated` integer DEFAULT false NOT NULL;