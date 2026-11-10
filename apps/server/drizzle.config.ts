import { defineConfig } from 'drizzle-kit'
import { env } from './src/env'

// generate 只比较 Schema 与迁移快照，无需数据库连接。
// migrate 等需要连接数据库的命令由 Drizzle Kit 验证 dbCredentials。
const databaseUrl = env.optionalDatabaseUrl

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'mysql',
  ...(databaseUrl ? { dbCredentials: { url: databaseUrl } } : {}),
})
