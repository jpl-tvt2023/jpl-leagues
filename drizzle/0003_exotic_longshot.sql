PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_gameweeks` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`league_id` text NOT NULL,
	`deadline` integer NOT NULL,
	`is_playoffs` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_gameweeks`("id", "number", "league_id", "deadline", "is_playoffs", "created_at", "updated_at") SELECT "id", "number", "league_id", "deadline", "is_playoffs", "created_at", "updated_at" FROM `gameweeks`;--> statement-breakpoint
DROP TABLE `gameweeks`;--> statement-breakpoint
ALTER TABLE `__new_gameweeks` RENAME TO `gameweeks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `gameweeks_league_number_unique` ON `gameweeks` (`league_id`,`number`);--> statement-breakpoint
CREATE TABLE `__new_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`league_id` text NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_groups`("id", "name", "league_id") SELECT "id", "name", "league_id" FROM `groups`;--> statement-breakpoint
DROP TABLE `groups`;--> statement-breakpoint
ALTER TABLE `__new_groups` RENAME TO `groups`;--> statement-breakpoint
CREATE UNIQUE INDEX `groups_league_name_unique` ON `groups` (`league_id`,`name`);--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`key` text NOT NULL,
	`league_id` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`key`, `league_id`),
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_settings`("key", "league_id", "value", "updated_at") SELECT "key", "league_id", "value", "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
CREATE TABLE `__new_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`league_id` text NOT NULL,
	`abbreviation` text NOT NULL,
	`password` text NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`group_id` text NOT NULL,
	`league_points` integer DEFAULT 0 NOT NULL,
	`bonus_points` integer DEFAULT 0 NOT NULL,
	`double_pointer_set1_used` integer DEFAULT false NOT NULL,
	`challenge_chip_set1_used` integer DEFAULT false NOT NULL,
	`win_win_set1_used` integer DEFAULT false NOT NULL,
	`double_pointer_set2_used` integer DEFAULT false NOT NULL,
	`challenge_chip_set2_used` integer DEFAULT false NOT NULL,
	`win_win_set2_used` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_teams`("id", "name", "league_id", "abbreviation", "password", "must_change_password", "group_id", "league_points", "bonus_points", "double_pointer_set1_used", "challenge_chip_set1_used", "win_win_set1_used", "double_pointer_set2_used", "challenge_chip_set2_used", "win_win_set2_used", "created_at", "updated_at") SELECT "id", "name", "league_id", "abbreviation", "password", "must_change_password", "group_id", "league_points", "bonus_points", "double_pointer_set1_used", "challenge_chip_set1_used", "win_win_set1_used", "double_pointer_set2_used", "challenge_chip_set2_used", "win_win_set2_used", "created_at", "updated_at" FROM `teams`;--> statement-breakpoint
DROP TABLE `teams`;--> statement-breakpoint
ALTER TABLE `__new_teams` RENAME TO `teams`;--> statement-breakpoint
CREATE UNIQUE INDEX `teams_league_name_unique` ON `teams` (`league_id`,`name`);