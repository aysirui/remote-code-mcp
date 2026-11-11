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
RENAME TABLE `audit_logs` TO `operation_logs`;--> statement-breakpoint
ALTER TABLE `operation_logs` DROP PRIMARY KEY;--> statement-breakpoint
ALTER TABLE `operation_logs` MODIFY COLUMN `user_id` varchar(48) NOT NULL;--> statement-breakpoint
ALTER TABLE `operation_logs` MODIFY COLUMN `workspace_id` varchar(48) NOT NULL;--> statement-breakpoint
ALTER TABLE `operation_logs` MODIFY COLUMN `status` varchar(20) NOT NULL;--> statement-breakpoint
ALTER TABLE `operation_logs` ADD PRIMARY KEY(`id`);--> statement-breakpoint
ALTER TABLE `operation_logs` ADD `operation_id` varchar(48) NOT NULL;--> statement-breakpoint
ALTER TABLE `operation_logs` ADD `client_id` varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE `operation_logs` ADD `tool_name` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `operation_logs` ADD `operation_type` varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE `operation_logs` ADD `duration_ms` int NOT NULL;--> statement-breakpoint
ALTER TABLE `operation_logs` ADD `error_code` varchar(64);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `local_file_policy` varchar(16) DEFAULT 'approval' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `local_git_policy` varchar(16) DEFAULT 'allow' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `local_command_policy` varchar(16) DEFAULT 'approval' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `cloud_file_policy` varchar(16) DEFAULT 'approval' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `cloud_git_policy` varchar(16) DEFAULT 'allow' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `cloud_command_policy` varchar(16) DEFAULT 'approval' NOT NULL;--> statement-breakpoint
ALTER TABLE `operation_logs` ADD CONSTRAINT `operation_logs_operation_id_unique` UNIQUE(`operation_id`);--> statement-breakpoint
CREATE INDEX `sec_actor_created_idx` ON `security_audits` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sec_resource_created_idx` ON `security_audits` (`resource_type`,`resource_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `op_user_created_idx` ON `operation_logs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `op_workspace_created_idx` ON `operation_logs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `op_client_created_idx` ON `operation_logs` (`client_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `operation_logs` DROP COLUMN `operation`;--> statement-breakpoint
ALTER TABLE `workspaces` DROP COLUMN `directory_name`;