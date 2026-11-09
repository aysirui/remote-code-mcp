import {
  mysqlTable,
  varchar,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/mysql-core'
const id = () => varchar('id', { length: 48 }).primaryKey()
/** 平台用户、角色与强制改密状态；密码只保存 bcrypt Hash。 */
export const users = mysqlTable('users', {
  id: id(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  passwordChangeRequired: boolean('password_change_required').notNull().default(false),
  role: varchar('role', { length: 20 }).notNull().default('user'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
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
/** 工作区本地授权与云端授权独立保存，执行权限取二者交集。 */
export const workspaces = mysqlTable(
  'workspaces',
  {
    id: id(),
    deviceId: varchar('device_id', { length: 48 }).notNull(),
    userId: varchar('user_id', { length: 48 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    localRead: boolean('local_read').notNull().default(true),
    localWrite: boolean('local_write').notNull().default(false),
    cloudRead: boolean('cloud_read').notNull().default(true),
    cloudWrite: boolean('cloud_write').notNull().default(true),
    localEnabled: boolean('local_enabled').notNull().default(true),
    cloudEnabled: boolean('cloud_enabled').notNull().default(true),
  },
  (t) => [index('ws_owner_idx').on(t.userId, t.deviceId)],
)
/** 动态注册的 OAuth 客户端及其允许的回调地址。 */
export const oauthClients = mysqlTable('oauth_clients', {
  id: id(),
  clientId: varchar('client_id', { length: 255 }).notNull().unique(),
  redirectUris: text('redirect_uris').notNull(),
  clientName: varchar('client_name', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
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
/** 记录用户、设备及工作区相关操作和结果。 */
export const auditLogs = mysqlTable('audit_logs', {
  id: id(),
  userId: varchar('user_id', { length: 48 }),
  deviceId: varchar('device_id', { length: 48 }),
  workspaceId: varchar('workspace_id', { length: 48 }),
  operation: varchar('operation', { length: 128 }).notNull(),
  status: varchar('status', { length: 32 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

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
