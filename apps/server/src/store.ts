import { env } from './env'
import { Injectable } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/mysql2'
import { createDatabasePool } from './database'
import * as S from './schema'
import { uid } from './security'

/**
 * 数据库基础设施入口。
 * 仅负责连接、通用单条查询与审计记录；业务权限由上层服务执行。
 */
@Injectable()
export class Store {
  readonly pool = createDatabasePool(env.databaseUrl)
  readonly db = drizzle(this.pool)
  /** 将查询结果收敛为可选的单条记录；未命中返回 undefined。 */
  async one<T>(query: Promise<T[]>): Promise<T | undefined> {
    return (await query)[0]
  }
  /** 写入操作审计日志，记录操作者及设备/工作区关联。 */
  async audit(
    operation: string,
    status: string,
    userId?: string,
    deviceId?: string,
    workspaceId?: string,
  ) {
    await this.db
      .insert(S.auditLogs)
      .values({ id: uid(), operation, status, userId, deviceId, workspaceId })
  }
}
