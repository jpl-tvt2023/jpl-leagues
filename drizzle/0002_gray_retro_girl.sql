DROP INDEX `gameweeks_number_unique`;--> statement-breakpoint
ALTER TABLE `gameweeks` ADD `league_id` text REFERENCES leagues(id);--> statement-breakpoint
DROP INDEX `groups_name_unique`;--> statement-breakpoint
ALTER TABLE `groups` ADD `league_id` text REFERENCES leagues(id);--> statement-breakpoint
DROP INDEX `teams_name_unique`;--> statement-breakpoint
ALTER TABLE `teams` ADD `league_id` text REFERENCES leagues(id);--> statement-breakpoint
CREATE UNIQUE INDEX `league_admins_league_user_unique` ON `league_admins` (`league_id`,`user_id`);