-- DEF-CHIP-009: add a nullable `bypass_reason` column to `gameweek_captains` so
-- the platform can audit cases where the per-player League-Stage captaincy cap
-- was intentionally exceeded. Two known bypass paths:
--   1. Admin CSV import (`/api/admin/[leagueId]/import-captains`) — admin override.
--   2. Auto-fallback in the GW processor — team failed to announce a captain and
--      the lowest performer is chosen despite their cap already being met.
-- The column is nullable; rows with the cap NOT exceeded leave it null.
-- See BR-CHIP-044 and the new auto-fallback BR (IDs assigned by the BA pass).

ALTER TABLE `gameweek_captains` ADD COLUMN `bypass_reason` TEXT;
