import dotenv from 'dotenv'
import path from 'node:path'

// src 与 dist 位于同一级，源码和构建产物均不依赖启动时的工作目录。
const envFiles = [path.resolve(__dirname, '../.env'), path.resolve(__dirname, '../../../.env')]

/** 统一配置入口：进程环境变量 > Server 本地 .env > 仓库根目录 .env > 默认值。 */
export class Env {
  constructor(
    private readonly source: NodeJS.ProcessEnv = process.env,
    files: string[] = envFiles,
  ) {
    dotenv.config({ path: files, processEnv: source, override: false, quiet: true })
  }

  /** Schema 生成不需要数据库连接，因此允许按需读取可选连接地址。 */
  get optionalDatabaseUrl(): string | undefined {
    return this.source.DATABASE_URL || undefined
  }

  /** 运行服务和执行数据库迁移时，数据库连接地址必须存在。 */
  get databaseUrl(): string {
    const value = this.optionalDatabaseUrl
    if (!value) throw new Error('必须配置 DATABASE_URL')
    return value
  }

  get appSecret(): string {
    const value = this.source.APP_SECRET
    if (!value || value.length < 32) throw new Error('APP_SECRET 必须至少包含 32 个字符')
    return value
  }

  get publicUrl(): string {
    return this.source.PUBLIC_URL || 'http://localhost:3000'
  }

  get consoleUrl(): string {
    return this.source.CONSOLE_URL || 'http://localhost:5173'
  }

  get adminEmail(): string {
    return (this.source.ADMIN_EMAIL || '').trim().toLowerCase()
  }

  get port(): number {
    const value = Number(this.source.PORT || 3000)
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error('PORT 必须是 1 到 65535 之间的整数')
    return value
  }

  /** 启动服务时完整校验；迁移和管理员初始化只校验各自需要的配置。 */
  validateServer(): void {
    void this.databaseUrl
    void this.appSecret
    void this.port
  }
}

// 导入模块时同步加载，保证数据库连接等初始化操作能读取本地配置。
export const env = new Env()
