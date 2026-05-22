ALTER TABLE `backups` ADD COLUMN `trades_json` TEXT;
--> statement-breakpoint
ALTER TABLE `backups` ADD COLUMN `penalty_redemptions_json` TEXT;
--> statement-breakpoint
ALTER TABLE `backups` ADD COLUMN `slot_unlocks_json` TEXT;
--> statement-breakpoint
ALTER TABLE `backups` ADD COLUMN `wishlists_json` TEXT;
--> statement-breakpoint
ALTER TABLE `backups` ADD COLUMN `notifications_json` TEXT;
--> statement-breakpoint
ALTER TABLE `backups` ADD COLUMN `auction_sessions_json` TEXT;
--> statement-breakpoint
ALTER TABLE `backups` ADD COLUMN `auction_bids_json` TEXT;
--> statement-breakpoint
ALTER TABLE `backups` ADD COLUMN `auction_bid_logs_json` TEXT;
