-- DEF-TRADE-005: physically drop the deprecated `veto_deadline` and `veto_votes`
-- columns from `trade_proposals`. The peer-veto system was removed earlier (the
-- veto endpoint now returns HTTP 410 Gone and the GET projection no longer
-- exposes these fields); this migration removes the columns themselves.
--
-- SQLite's `ALTER TABLE ... DROP COLUMN` support varies by version, so we use
-- the recreate-table pattern. Foreign keys referencing `trade_proposals.id`
-- from other tables remain valid because the new table is renamed back to the
-- original name within the same transaction.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
BEGIN TRANSACTION;--> statement-breakpoint

CREATE TABLE `__new_trade_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`proposer_team_id` text NOT NULL,
	`target_team_id` text NOT NULL,
	`offered_player_ids` text DEFAULT '[]' NOT NULL,
	`requested_player_ids` text DEFAULT '[]' NOT NULL,
	`cash_offered` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proposer_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

INSERT INTO `__new_trade_proposals` ("id", "league_id", "proposer_team_id", "target_team_id", "offered_player_ids", "requested_player_ids", "cash_offered", "status", "created_at", "updated_at")
SELECT "id", "league_id", "proposer_team_id", "target_team_id", "offered_player_ids", "requested_player_ids", "cash_offered", "status", "created_at", "updated_at" FROM `trade_proposals`;--> statement-breakpoint

DROP TABLE `trade_proposals`;--> statement-breakpoint
ALTER TABLE `__new_trade_proposals` RENAME TO `trade_proposals`;--> statement-breakpoint

-- No indexes existed on `trade_proposals` in prior migrations (0000, 0001), so
-- none need to be recreated here.

COMMIT;--> statement-breakpoint
PRAGMA foreign_keys=ON;
