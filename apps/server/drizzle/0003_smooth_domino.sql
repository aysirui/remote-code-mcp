CREATE TABLE `workspace_revocations` (
	`id` varchar(48) NOT NULL,
	`device_id` varchar(48) NOT NULL,
	`user_id` varchar(48) NOT NULL,
	`revoked_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `workspace_revocations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `workspace_revocation_device_idx` ON `workspace_revocations` (`device_id`);