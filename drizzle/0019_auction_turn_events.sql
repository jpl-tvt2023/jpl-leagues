CREATE TABLE `auction_turn_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`league_id` text NOT NULL,
	`team_id` text,
	`nominator_index` integer,
	`event` text NOT NULL,
	`actor` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `auction_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE INDEX `auction_turn_events_session_created` ON `auction_turn_events` (`session_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `auction_sessions` ADD COLUMN `makeup_queue` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `auction_sessions` ADD COLUMN `ring_return_index` integer;
