ALTER TABLE `gameweek_chips` ADD `average_score_at_use` integer;--> statement-breakpoint
ALTER TABLE `leagues` ADD `team_size` integer DEFAULT 32 NOT NULL;--> statement-breakpoint
ALTER TABLE `leagues` ADD `group_count` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `leagues` ADD `playoff_start_gw` integer DEFAULT 31 NOT NULL;--> statement-breakpoint
ALTER TABLE `playoff_ties` ADD `league_id` text NOT NULL REFERENCES leagues(id);--> statement-breakpoint
ALTER TABLE `teams` ADD `score_lock_set1_used` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `comeback_set1_used` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `underdog_set1_used` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `score_lock_set2_used` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `comeback_set2_used` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `underdog_set2_used` integer DEFAULT false NOT NULL;