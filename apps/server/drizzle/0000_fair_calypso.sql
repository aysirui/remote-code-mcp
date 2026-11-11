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
CREATE TABLE `oauth_tokens` (
	`id` varchar(48) NOT NULL,
	`token_hash` varchar(128) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`user_id` varchar(48) NOT NULL,
	`grant_id` varchar(48),
	`scope` varchar(255) NOT NULL,
	`resource` text NOT NULL,
	`expires_at` timestamp NOT NULL,
	`revoked_at` timestamp,
	CONSTRAINT `oauth_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_tokens_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `operation_logs` (
	`id` varchar(48) NOT NULL,
	`operation_id` varchar(48) NOT NULL,
	`user_id` varchar(48) NOT NULL,
	`device_id` varchar(48),
	`workspace_id` varchar(48) NOT NULL,
	`client_id` varchar(255) NOT NULL,
	`tool_name` varchar(128) NOT NULL,
	`operation_type` varchar(32) NOT NULL,
	`status` varchar(20) NOT NULL,
	`duration_ms` int NOT NULL,
	`error_code` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `operation_logs_id` PRIMARY KEY(`id`),
	CONSTRAINT `operation_logs_operation_id_unique` UNIQUE(`operation_id`)
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
CREATE TABLE `security_audits` (
	`id` varchar(48) NOT NULL,
	`actor_type` varchar(20) NOT NULL,
	`actor_id` varchar(48) NOT NULL,
	`event_type` varchar(100) NOT NULL,
	`resource_type` varchar(32),
	`resource_id` varchar(255),
	`result` varchar(20) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `security_audits_id` PRIMARY KEY(`id`)
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
	`local_file_policy` varchar(16) NOT NULL DEFAULT 'approval',
	`local_git_policy` varchar(16) NOT NULL DEFAULT 'allow',
	`local_command_policy` varchar(16) NOT NULL DEFAULT 'approval',
	`cloud_file_policy` varchar(16) NOT NULL DEFAULT 'approval',
	`cloud_git_policy` varchar(16) NOT NULL DEFAULT 'allow',
	`cloud_command_policy` varchar(16) NOT NULL DEFAULT 'approval',
	`local_enabled` boolean NOT NULL DEFAULT true,
	`cloud_enabled` boolean NOT NULL DEFAULT true,
	CONSTRAINT `workspaces_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `device_token_idx` ON `device_tokens` (`device_id`);--> statement-breakpoint
CREATE INDEX `device_owner_idx` ON `devices` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_family_idx` ON `oauth_refresh_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_grant_idx` ON `oauth_refresh_tokens` (`grant_id`);--> statement-breakpoint
CREATE INDEX `op_user_created_idx` ON `operation_logs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `op_workspace_created_idx` ON `operation_logs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `op_client_created_idx` ON `operation_logs` (`client_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sec_actor_created_idx` ON `security_audits` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sec_resource_created_idx` ON `security_audits` (`resource_type`,`resource_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sess_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `ws_owner_idx` ON `workspaces` (`user_id`,`device_id`);