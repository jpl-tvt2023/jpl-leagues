CREATE TABLE `team_slot_unlocks` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`team_id` text NOT NULL,
	`slot_number` integer NOT NULL,
	`cost` integer NOT NULL,
	`unlocked_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_slot_unlocks_team` ON `team_slot_unlocks` (`team_id`);
