CREATE TABLE `email_activations` (
	`user_id` varchar(48) NOT NULL,
	`token_hash` varchar(128) NOT NULL,
	`expires_at` timestamp NOT NULL,
	`sent_at` timestamp NOT NULL,
	CONSTRAINT `email_activations_user_id` PRIMARY KEY(`user_id`),
	CONSTRAINT `email_activations_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified` boolean DEFAULT true NOT NULL;