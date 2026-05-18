CREATE TABLE `auction_club_ownership` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`team_id` text NOT NULL,
	`pl_team_id` integer NOT NULL,
	`pl_team_name` text NOT NULL,
	`pl_team_short` text NOT NULL,
	`tier` text NOT NULL,
	`purchase_price` integer NOT NULL,
	`acquired_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auction_club_team_unique` ON `auction_club_ownership` (`league_id`,`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `auction_club_pl_unique` ON `auction_club_ownership` (`league_id`,`pl_team_id`);--> statement-breakpoint
CREATE TABLE `pl_standings_config` (
	`id` text PRIMARY KEY NOT NULL,
	`season` text NOT NULL,
	`top8` text NOT NULL,
	`mid` text NOT NULL,
	`promoted` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `auction_scores` ADD `raw_points` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `auction_scores` ADD `synergy_bonus` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `auction_scores` ADD `club_result_bonus` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `leagues` ADD `club_auction_enabled` integer DEFAULT false NOT NULL;
