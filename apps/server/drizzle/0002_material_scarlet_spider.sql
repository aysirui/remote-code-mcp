CREATE TABLE `oauth_consents` (
	`id` varchar(48) NOT NULL,
	`csrf_hash` varchar(128) NOT NULL,
	`user_id` varchar(48) NOT NULL,
	`expires_at` timestamp NOT NULL,
	`consumed_at` timestamp,
	CONSTRAINT `oauth_consents_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_consents_csrf_hash_unique` UNIQUE(`csrf_hash`)
);
--> statement-breakpoint
CREATE INDEX `oauth_consent_user_idx` ON `oauth_consents` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_consent_expiry_idx` ON `oauth_consents` (`expires_at`);