CREATE TABLE `audit_logs` (
	`id` varchar(48) NOT NULL,
	`user_id` varchar(48),
	`device_id` varchar(48),
	`workspace_id` varchar(48),
	`operation` varchar(128) NOT NULL,
	`status` varchar(32) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `device_tokens` (
	`id` varchar(48) NOT NULL,
	`device_id` varchar(48) NOT NULL,
	`token_hash` varchar(128) NOT NULL,
	`revoked_at` timestamp,
	CONSTRAINT `device_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `device_tokens_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` varchar(48) NOT NULL,
	`user_id` varchar(48) NOT NULL,
	`name` varchar(128) NOT NULL,
	`platform` varchar(64) NOT NULL,
	`status` varchar(20) NOT NULL DEFAULT 'active',
	`last_seen_at` timestamp,
	`runtime_version` varchar(32),
	CONSTRAINT `devices_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_clients` (
	`id` varchar(48) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`redirect_uris` text NOT NULL,
	`client_name` varchar(255),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `oauth_clients_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_clients_client_id_unique` UNIQUE(`client_id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`id` varchar(48) NOT NULL,
	`code_hash` varchar(128) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`user_id` varchar(48) NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` varchar(128) NOT NULL,
	`scope` varchar(255) NOT NULL,
	`resource` text NOT NULL,
	`expires_at` timestamp NOT NULL,
	CONSTRAINT `oauth_codes_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_codes_code_hash_unique` UNIQUE(`code_hash`)
);
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` varchar(48) NOT NULL,
	`token_hash` varchar(128) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`user_id` varchar(48) NOT NULL,
	`scope` varchar(255) NOT NULL,
	`resource` text NOT NULL,
	`expires_at` timestamp NOT NULL,
	`revoked_at` timestamp,
	CONSTRAINT `oauth_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_tokens_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `pairings` (
	`id` varchar(48) NOT NULL,
	`code_hash` varchar(128) NOT NULL,
	`secret_hash` varchar(128) NOT NULL,
	`device_name` varchar(128) NOT NULL,
	`platform` varchar(64) NOT NULL,
	`status` varchar(20) NOT NULL DEFAULT 'pending',
	`device_id` varchar(48),
	`token_ciphertext` text,
	`expires_at` timestamp NOT NULL,
	CONSTRAINT `pairings_id` PRIMARY KEY(`id`),
	CONSTRAINT `pairings_code_hash_unique` UNIQUE(`code_hash`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` varchar(128) NOT NULL,
	`user_id` varchar(48) NOT NULL,
	`expires_at` timestamp NOT NULL,
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(48) NOT NULL,
	`email` varchar(255) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`password_change_required` boolean NOT NULL DEFAULT false,
	`role` varchar(20) NOT NULL DEFAULT 'user',
	`status` varchar(20) NOT NULL DEFAULT 'active',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` varchar(48) NOT NULL,
	`device_id` varchar(48) NOT NULL,
	`user_id` varchar(48) NOT NULL,
	`name` varchar(128) NOT NULL,
	`local_read` boolean NOT NULL DEFAULT true,
	`local_write` boolean NOT NULL DEFAULT false,
	`cloud_read` boolean NOT NULL DEFAULT true,
	`cloud_write` boolean NOT NULL DEFAULT true,
	`local_enabled` boolean NOT NULL DEFAULT true,
	`cloud_enabled` boolean NOT NULL DEFAULT true,
	CONSTRAINT `workspaces_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `device_token_idx` ON `device_tokens` (`device_id`);--> statement-breakpoint
CREATE INDEX `device_owner_idx` ON `devices` (`user_id`);--> statement-breakpoint
CREATE INDEX `sess_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `ws_owner_idx` ON `workspaces` (`user_id`,`device_id`);