-- Release refund breakdown. The refund itself is already snapshotted in release_refund (0018);
-- these record how it was priced so the breakdown can be shown again later:
--   release_fmv      FMV used for the "100% of FMV gain" part. Null = priced before this existed.
--   deadwood_reason  "no_minutes" | "unavailable" when priced at the 80% deadwood rate; null = standard.
-- See src/lib/formats/auction/release-refund.ts.
ALTER TABLE `auction_ownership` ADD `release_fmv` integer;--> statement-breakpoint
ALTER TABLE `auction_ownership` ADD `deadwood_reason` text;
