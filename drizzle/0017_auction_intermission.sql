ALTER TABLE `auction_sessions` ADD COLUMN `intermission_seconds` INTEGER NOT NULL DEFAULT 5;--> statement-breakpoint
ALTER TABLE `auction_sessions` ADD COLUMN `intermission_until` INTEGER;
