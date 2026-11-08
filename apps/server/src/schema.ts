import {
  mysqlTable,
  varchar,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  int,
} from 'drizzle-orm/mysql-core'
const id = () => varchar('id', { length: 48 }).primaryKey()
export const users = mysqlTable('users', {
  id: id(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  passwordChangeRequired: boolean('password_change_required').notNull().default(false),
  role: varchar('role', { length: 20 }).notNull().default('user'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
export const sessions = mysqlTable(
  'sessions',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    userId: varchar('user_id', { length: 48 }).notNull(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (t) => [index('sess_user_idx').on(t.userId)],
)
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
export const oauthClients = mysqlTable('oauth_clients', {
  id: id(),
  clientId: varchar('client_id', { length: 255 }).notNull().unique(),
  redirectUris: text('redirect_uris').notNull(),
  clientName: varchar('client_name', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
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
export const oauthTokens = mysqlTable('oauth_tokens', {
  id: id(),
  tokenHash: varchar('token_hash', { length: 128 }).notNull().unique(),
  clientId: varchar('client_id', { length: 255 }).notNull(),
  userId: varchar('user_id', { length: 48 }).notNull(),
  scope: varchar('scope', { length: 255 }).notNull(),
  resource: text('resource').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
})
export const auditLogs = mysqlTable('audit_logs', {
  id: id(),
  userId: varchar('user_id', { length: 48 }),
  deviceId: varchar('device_id', { length: 48 }),
  workspaceId: varchar('workspace_id', { length: 48 }),
  operation: varchar('operation', { length: 128 }).notNull(),
  status: varchar('status', { length: 32 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
