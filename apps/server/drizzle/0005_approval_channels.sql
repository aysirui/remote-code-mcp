CREATE TABLE `approval_channel_bindings` (
	`user_id` varchar(48) NOT NULL,
	`channel` varchar(16) NOT NULL,
	`app_id` varchar(96) NOT NULL,
	`platform_user_id` varchar(128) NOT NULL,
	`revision` varchar(36) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	CONSTRAINT `approval_channel_bindings_user_id_channel_pk` PRIMARY KEY(`user_id`,`channel`),
	CONSTRAINT `approval_channel_identity_idx` UNIQUE(`channel`,`app_id`,`platform_user_id`)
);
--> statement-breakpoint
CREATE TABLE `approval_channel_challenges` (
	`user_id` varchar(48) NOT NULL,
	`channel` varchar(16) NOT NULL,
	`app_id` varchar(96) NOT NULL,
	`code_hash` varchar(64) NOT NULL,
	`confirmation_hash` varchar(64),
	`platform_user_id` varchar(128),
	`expires_at` timestamp NOT NULL,
	CONSTRAINT `approval_channel_challenges_user_id_channel_pk` PRIMARY KEY(`user_id`,`channel`),
	CONSTRAINT `approval_channel_challenges_code_hash_unique` UNIQUE(`code_hash`)
);
