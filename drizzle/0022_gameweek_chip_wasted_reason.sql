-- Why a TVT chip was wasted, when it was. Null means "not wasted".
--
-- Waste is recorded here rather than by flipping is_valid to false: the force-reprocess reset in
-- api/gameweeks/[gw]/route.ts clears is_processed / points_awarded / had_negative_hits /
-- wasted_reason but deliberately leaves is_valid alone, so an invalidated chip would be excluded
-- from the scorer's own `is_valid = 1` query on every later reprocess.
ALTER TABLE `gameweek_chips` ADD `wasted_reason` text;
