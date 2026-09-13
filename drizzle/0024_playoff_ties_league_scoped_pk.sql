-- playoff_ties: primary key becomes (league_id, tie_id).
--
-- `tie_id` holds a bracket-position LABEL — "RO16-A", "16T-SF-A", "JCL-SF-1" — taken from the
-- seeding tables in lib/formats/tvt/playoffs.ts. It carries no league component, so as a lone
-- primary key it let the first league to generate playoffs claim every label; every other league
-- died on `UNIQUE constraint failed: playoff_ties.tie_id`.
--
-- Namespacing the VALUE was the wrong fix: the label is rendered to users on the playoff card and
-- the dashboard heading, and generate-playoffs parses it back with startsWith() to derive a round
-- name. Scoping the KEY leaves all of that untouched.
--
-- SQLite cannot alter a primary key in place, so this is a table rebuild.
PRAGMA foreign_keys=OFF;--> statement-breakpoint

CREATE TABLE `__new_playoff_ties` (
	`tie_id` text NOT NULL,
	`league_id` text NOT NULL,
	`round_name` text NOT NULL,
	`round_type` text NOT NULL,
	`home_team_id` text,
	`away_team_id` text,
	`home_aggregate` integer DEFAULT 0 NOT NULL,
	`away_aggregate` integer DEFAULT 0 NOT NULL,
	`winner_id` text,
	`loser_id` text,
	`gw1` integer NOT NULL,
	`gw2` integer,
	`gw3` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`league_id`, `tie_id`),
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`home_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`away_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`winner_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`loser_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint

INSERT INTO `__new_playoff_ties` SELECT * FROM `playoff_ties`;--> statement-breakpoint
DROP TABLE `playoff_ties`;--> statement-breakpoint
ALTER TABLE `__new_playoff_ties` RENAME TO `playoff_ties`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
