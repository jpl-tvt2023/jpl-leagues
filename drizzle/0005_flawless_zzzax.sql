CREATE TABLE `backups` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`trigger` text NOT NULL,
	`created_at` integer NOT NULL,
	`teams_json` text,
	`fixtures_json` text NOT NULL,
	`captains_json` text,
	`chips_json` text,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade
);
