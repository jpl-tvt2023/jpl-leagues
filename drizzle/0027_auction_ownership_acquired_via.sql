-- Trades keep ownership history. A trade used to move the ownership row to its new team in place,
-- which erased the seller's scoring window (reprocessing an earlier gameweek credited the buyer)
-- and moved the "Purchased" ledger entry with it. Now the seller keeps a closed copy of the row
-- (status 'transferred', released_gw = the trade's gameweek) and the row itself moves on.
--   acquired_via  'auction' = bought, a purchase on the ledger; 'trade' = received in a trade.
-- The one-live-owner index now excludes 'transferred' history rows as well as 'released' ones.
ALTER TABLE `auction_ownership` ADD `acquired_via` text DEFAULT 'auction' NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `auction_ownership_active_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `auction_ownership_active_unique` ON `auction_ownership` (`league_id`,`fpl_element_id`) WHERE status NOT IN ('released', 'transferred');
