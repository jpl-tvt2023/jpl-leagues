-- One live owner per player, not one row per player ever. A released player keeps his row as
-- history (scoring reads its acquired/released window to credit past gameweeks), so the old
-- index on every row made buying him back in a mini-auction fail on UNIQUE. Released rows are
-- now excluded; active / pending_release / deadwood stay at most one per player.
DROP INDEX IF EXISTS `auction_ownership_active_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `auction_ownership_active_unique` ON `auction_ownership` (`league_id`,`fpl_element_id`) WHERE status <> 'released';
