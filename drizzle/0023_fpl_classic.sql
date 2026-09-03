-- FPL Classic format: plain public FPL mini-leagues, read-only, no login accounts.
--
-- Four new tables, no column added to any existing table — see the docblock in
-- src/lib/db/schema.ts above `fplClassicConfig` for why that matters here specifically.

CREATE TABLE `fpl_classic_config` (
	`league_id` text PRIMARY KEY NOT NULL,
	`fpl_league_id` integer NOT NULL,
	`fpl_league_name` text,
	`fpl_start_event` integer,
	`start_gameweek` integer DEFAULT 1 NOT NULL,
	`scoring_metric` text DEFAULT 'net' NOT NULL,
	`winner_cut_percent` integer DEFAULT 30 NOT NULL,
	`entrants_synced_at` integer,
	`entrant_count` integer DEFAULT 0 NOT NULL,
	`settled_through_gw` integer DEFAULT 0 NOT NULL,
	`last_sync_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fpl_classic_config_fpl_league` ON `fpl_classic_config` (`fpl_league_id`);
--> statement-breakpoint
CREATE TABLE `fpl_classic_entrants` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`fpl_entry_id` integer NOT NULL,
	`entry_name` text NOT NULL,
	`player_name` text NOT NULL,
	`joined_time` integer,
	`first_seen_gw` integer DEFAULT 1 NOT NULL,
	`total_points` integer DEFAULT 0 NOT NULL,
	`last_rank` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fpl_classic_entrants_league_entry_unique` ON `fpl_classic_entrants` (`league_id`,`fpl_entry_id`);
--> statement-breakpoint
CREATE INDEX `fpl_classic_entrants_league_total` ON `fpl_classic_entrants` (`league_id`,`total_points`);
--> statement-breakpoint
CREATE TABLE `fpl_classic_entry_gws` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`entrant_id` text NOT NULL,
	`gw` integer NOT NULL,
	`points` integer NOT NULL,
	`transfer_cost` integer DEFAULT 0 NOT NULL,
	`net_points` integer NOT NULL,
	`total_points` integer NOT NULL,
	`overall_rank` integer,
	`bench_points` integer DEFAULT 0 NOT NULL,
	`chip` text,
	`month_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entrant_id`) REFERENCES `fpl_classic_entrants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fpl_classic_entry_gws_unique` ON `fpl_classic_entry_gws` (`entrant_id`,`gw`);
--> statement-breakpoint
CREATE INDEX `fpl_classic_entry_gws_league_gw_net` ON `fpl_classic_entry_gws` (`league_id`,`gw`,`net_points`);
--> statement-breakpoint
CREATE INDEX `fpl_classic_entry_gws_league_month` ON `fpl_classic_entry_gws` (`league_id`,`month_key`);
--> statement-breakpoint
CREATE TABLE `fpl_classic_awards` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`award_type` text NOT NULL,
	`scope_key` text NOT NULL,
	`position` integer DEFAULT 1 NOT NULL,
	`entrant_id` text NOT NULL,
	`value` integer NOT NULL,
	`is_tied` integer DEFAULT false NOT NULL,
	`detail` text,
	`computed_at` integer NOT NULL,
	`computed_through_gw` integer,
	`recompute_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entrant_id`) REFERENCES `fpl_classic_entrants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fpl_classic_awards_unique` ON `fpl_classic_awards` (`league_id`,`award_type`,`scope_key`,`position`,`entrant_id`);
--> statement-breakpoint
CREATE INDEX `fpl_classic_awards_league_type` ON `fpl_classic_awards` (`league_id`,`award_type`);
