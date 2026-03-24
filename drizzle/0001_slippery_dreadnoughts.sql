CREATE TABLE `league_admins` (
	`id` text PRIMARY KEY NOT NULL,
	`league_id` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`league_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `leagues` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`sport` text NOT NULL,
	`format` text NOT NULL,
	`season` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leagues_slug_unique` ON `leagues` (`slug`);--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `must_change_password` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `is_admin`;