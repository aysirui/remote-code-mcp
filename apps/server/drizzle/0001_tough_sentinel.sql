CREATE TABLE `oauth_grants` (
	`id` varchar(48) NOT NULL,
	`user_id` varchar(48) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`scope` varchar(255) NOT NULL,
	`resource` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`last_used_at` timestamp,
	`revoked_at` timestamp,
	CONSTRAINT `oauth_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_grant_user_client_unique` UNIQUE(`user_id`,`client_id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`id` varchar(48) NOT NULL,
	`token_hash` varchar(128) NOT NULL,
	`family_id` varchar(48) NOT NULL,
	`grant_id` varchar(48) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`expires_at` timestamp NOT NULL,
	`consumed_at` timestamp,
	`revoked_at` timestamp,
	CONSTRAINT `oauth_refresh_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_refresh_tokens_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `oauth_tokens` ADD `grant_id` varchar(48);--> statement-breakpoint
CREATE INDEX `oauth_refresh_family_idx` ON `oauth_refresh_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_grant_idx` ON `oauth_refresh_tokens` (`grant_id`);