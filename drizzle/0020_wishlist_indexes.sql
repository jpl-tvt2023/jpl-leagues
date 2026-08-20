CREATE INDEX `auction_wishlists_team_priority` ON `auction_wishlists` (`team_id`,`priority`);--> statement-breakpoint
CREATE UNIQUE INDEX `auction_wishlists_team_element` ON `auction_wishlists` (`team_id`,`fpl_element_id`);
