import {
  mysqlTable,
  varchar,
  text,
  timestamp,
  boolean,
  int,
  index,
  uniqueIndex,
} from 'drizzle-orm/mysql-core'
const id = () => varchar('id', { length: 48 }).primaryKey()
/** 平台用户、角色与强制改密状态；密码只保存 bcrypt Hash。 */
export const users = mysqlTable('users', {
  id: id(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  /** 邮箱验证标记：默认 true 兼容存量账号；公开注册必须显式写入 false。 */
  emailVerified: boolean('email_verified').notNull().default(true),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  passwordChangeRequired: boolean('password_change_required').notNull().default(false),
  role: varchar('role', { length: 20 }).notNull().default('user'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
/** 每用户一条邮箱激活记录；仅保存令牌摘要，重发替换旧令牌。 */
export const emailActivations = mysqlTable('email_activations', {
  /** 用户 ID，同时保证每用户仅有一条激活记录。 */
  userId: varchar('user_id', { length: 48 }).primaryKey(),
  /** 随机激活令牌的 SHA-256 摘要，不保存邮件中的明文。 */
  tokenHash: varchar('token_hash', { length: 128 }).notNull().unique(),
  /** 链接有效期截止时间，发送后 24 小时。 */
  expiresAt: timestamp('expires_at').notNull(),
  /** 最近一次发送尝试时间，用于跨进程限制 60 秒冷却。 */
  sentAt: timestamp('sent_at').notNull(),
})
/** 服务器 Session 的 SHA-256 摘要及到期时间，不保存明文 Session Cookie。 */
export const sessions = mysqlTable(
  'sessions',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    userId: varchar('user_id', { length: 48 }).notNull(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (t) => [index('sess_user_idx').on(t.userId)],
)
/** 绑定到某个用户的 Runtime 设备及其连接状态。 */
export const devices = mysqlTable(
  'devices',
  {
    id: id(),
    userId: varchar('user_id', { length: 48 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    platform: varchar('platform', { length: 64 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    lastSeenAt: timestamp('last_seen_at'),
    runtimeVersion: varchar('runtime_version', { length: 32 }),
  },
  (t) => [index('device_owner_idx').on(t.userId)],
)
/** 一次性设备配对事务，保存哈希化配对码与临时加密凭据。 */
export const pairings = mysqlTable('pairings', {
  id: id(),
  codeHash: varchar('code_hash', { length: 128 }).notNull().unique(),
  secretHash: varchar('secret_hash', { length: 128 }).notNull(),
  deviceName: varchar('device_name', { length: 128 }).notNull(),
  platform: varchar('platform', { length: 64 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  deviceId: varchar('device_id', { length: 48 }),
  tokenCiphertext: text('token_ciphertext'),
  expiresAt: timestamp('expires_at').notNull(),
})
/** 设备 Bearer Token 摘要及撤销时间。 */
export const deviceTokens = mysqlTable(
  'device_tokens',
  {
    id: id(),
    deviceId: varchar('device_id', { length: 48 }).notNull(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull().unique(),
    revokedAt: timestamp('revoked_at'),
  },
  (t) => [index('device_token_idx').on(t.deviceId)],
)
/**
 * Runtime 同步的工作区授权快照；云端不维护独立策略。
 * 仅保存用户自定义名称和稳定 ID，不保存本地路径、目录名或项目结构。
 */
export const workspaces = mysqlTable(
  'workspaces',
  {
    id: id(),
    deviceId: varchar('device_id', { length: 48 }).notNull(),
    userId: varchar('user_id', { length: 48 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    localRead: boolean('local_read').notNull().default(true),
    localWrite: boolean('local_write').notNull().default(false),
    localFilePolicy: varchar('local_file_policy', { length: 16 }).notNull().default('approval'),
    localGitPolicy: varchar('local_git_policy', { length: 16 }).notNull().default('allow'),
    localCommandPolicy: varchar('local_command_policy', { length: 16 })
      .notNull()
      .default('approval'),
    localEnabled: boolean('local_enabled').notNull().default(true),
  },
  (t) => [index('ws_owner_idx').on(t.userId, t.deviceId)],
)
/** Server 主动撤销的工作区授权墓碑，防止 Runtime 重连快照重新创建授权。 */
export const workspaceRevocations = mysqlTable(
  'workspace_revocations',
  {
    id: id(),
    deviceId: varchar('device_id', { length: 48 }).notNull(),
    userId: varchar('user_id', { length: 48 }).notNull(),
    revokedAt: timestamp('revoked_at').notNull().defaultNow(),
  },
  (t) => [index('workspace_revocation_device_idx').on(t.deviceId)],
)

/** 动态注册的 OAuth 客户端及其允许的回调地址。 */
export const oauthClients = mysqlTable('oauth_clients', {
  id: id(),
  clientId: varchar('client_id', { length: 255 }).notNull().unique(),
  redirectUris: text('redirect_uris').notNull(),
  clientName: varchar('client_name', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
/** 浏览器 OAuth 授权确认的一次性状态；只保存 CSRF 摘要并由事务原子消费。 */
export const oauthConsents = mysqlTable(
  'oauth_consents',
  {
    id: id(),
    csrfHash: varchar('csrf_hash', { length: 128 }).notNull().unique(),
    userId: varchar('user_id', { length: 48 }).notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
  },
  (t) => [
    index('oauth_consent_user_idx').on(t.userId),
    index('oauth_consent_expiry_idx').on(t.expiresAt),
  ],
)
/** 短期一次性 OAuth 授权码及 PKCE 挑战信息。 */
export const oauthCodes = mysqlTable('oauth_codes', {
  id: id(),
  codeHash: varchar('code_hash', { length: 128 }).notNull().unique(),
  clientId: varchar('client_id', { length: 255 }).notNull(),
  userId: varchar('user_id', { length: 48 }).notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: varchar('code_challenge', { length: 128 }).notNull(),
  scope: varchar('scope', { length: 255 }).notNull(),
  resource: text('resource').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
})
/** OAuth 访问令牌摘要、Scope、受众与失效信息。 */
export const oauthTokens = mysqlTable('oauth_tokens', {
  id: id(),
  tokenHash: varchar('token_hash', { length: 128 }).notNull().unique(),
  clientId: varchar('client_id', { length: 255 }).notNull(),
  userId: varchar('user_id', { length: 48 }).notNull(),
  grantId: varchar('grant_id', { length: 48 }),
  scope: varchar('scope', { length: 255 }).notNull(),
  resource: text('resource').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
})
/**
 * MCP 工具执行元数据。
 * 只允许额外保存脱敏命令摘要；不保存路径、原始参数、文件内容、Diff、输出或对话正文。
 */
export const operationLogs = mysqlTable(
  'operation_logs',
  {
    id: id(),
    operationId: varchar('operation_id', { length: 48 }).notNull().unique(),
    userId: varchar('user_id', { length: 48 }).notNull(),
    deviceId: varchar('device_id', { length: 48 }),
    workspaceId: varchar('workspace_id', { length: 48 }).notNull(),
    clientId: varchar('client_id', { length: 255 }).notNull(),
    toolName: varchar('tool_name', { length: 128 }).notNull(),
    commandSummary: text('command_summary'),
    operationType: varchar('operation_type', { length: 32 }).notNull(),
    status: varchar('status', { length: 20 }).notNull(),
    durationMs: int('duration_ms').notNull(),
    errorCode: varchar('error_code', { length: 64 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('op_user_created_idx').on(t.userId, t.createdAt),
    index('op_workspace_created_idx').on(t.workspaceId, t.createdAt),
    index('op_client_created_idx').on(t.clientId, t.createdAt),
  ],
)
/** 平台安全审计：仅记录谁在何时对哪类资源执行了什么管理动作及结果。 */
export const securityAudits = mysqlTable(
  'security_audits',
  {
    id: id(),
    actorType: varchar('actor_type', { length: 20 }).notNull(),
    actorId: varchar('actor_id', { length: 48 }).notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    resourceType: varchar('resource_type', { length: 32 }),
    resourceId: varchar('resource_id', { length: 255 }),
    result: varchar('result', { length: 20 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('sec_actor_created_idx').on(t.actorId, t.createdAt),
    index('sec_resource_created_idx').on(t.resourceType, t.resourceId, t.createdAt),
  ],
)
/** 长期客户端授权，与短期 Access Token 分离。 */
export const oauthGrants = mysqlTable(
  'oauth_grants',
  {
    id: id(),
    userId: varchar('user_id', { length: 48 }).notNull(),
    clientId: varchar('client_id', { length: 255 }).notNull(),
    scope: varchar('scope', { length: 255 }).notNull(),
    resource: text('resource').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at'),
    revokedAt: timestamp('revoked_at'),
  },
  (t) => [uniqueIndex('oauth_grant_user_client_unique').on(t.userId, t.clientId)],
)
/** 一次性轮换的 Refresh Token，仅保存摘要；familyId 关联重放后的整族撤销。 */
export const oauthRefreshTokens = mysqlTable(
  'oauth_refresh_tokens',
  {
    id: id(),
    tokenHash: varchar('token_hash', { length: 128 }).notNull().unique(),
    familyId: varchar('family_id', { length: 48 }).notNull(),
    grantId: varchar('grant_id', { length: 48 }).notNull(),
    clientId: varchar('client_id', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
    revokedAt: timestamp('revoked_at'),
  },
  (t) => [
    index('oauth_refresh_family_idx').on(t.familyId),
    index('oauth_refresh_grant_idx').on(t.grantId),
  ],
)
