ALTER TABLE `leagues` ADD `start_gameweek` integer DEFAULT 1 NOT NULL;
ALTER TABLE `leagues` ADD `release_cycle_gws` text DEFAULT '[10,20,30]' NOT NULL;
