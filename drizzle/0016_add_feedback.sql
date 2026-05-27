-- Feature: user feedback. New `feedback` table holding free-text user submissions.
-- Scope is "site" (general platform feedback, visible to superadmins) or "league"
-- (visible to that league's admins + superadmins). `league_id` is null when
-- scope='site'. Admins can flag rows important, mark them resolved (with optional
-- note), and delete them.

CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`league_id` text,
	`submitter_team_id` text NOT NULL,
	`submitter_name` text NOT NULL,
	`subject` text,
	`message` text NOT NULL,
	`is_important` integer DEFAULT false NOT NULL,
	`resolved_at` integer,
	`resolution_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submitter_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `feedback_scope_created` ON `feedback` (`scope`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_league_created` ON `feedback` (`league_id`,`created_at`);
