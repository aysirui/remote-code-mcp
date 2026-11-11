import { env } from './env'
import { Injectable } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/mysql2'
import { createDatabasePool } from './database'
import * as S from './schema'
import { uid } from './security'

export type OperationType = 'file' | 'git' | 'command'
export type OperationStatus = 'success' | 'failed'

/** 数据库基础设施入口；操作日志与安全审计使用不同的数据模型。 */
@Injectable()
export class Store {
  readonly pool = createDatabasePool(env.databaseUrl)
  readonly db = drizzle(this.pool)

  /** 将查询结果收敛为可选的单条记录；未命中返回 undefined。 */
  async one<T>(query: Promise<T[]>): Promise<T | undefined> {
    return (await query)[0]
  }

  /**
   * 记录 MCP 工具执行的最小元数据。
   * 此方法不接收 payload、路径、命令、输出、Diff 或对话信息，避免误存隐私数据。
   */
  async logOperation(input: {
    operationId: string
    userId: string
    deviceId?: string
    workspaceId: string
    clientId: string
    toolName: string
    operationType: OperationType
    status: OperationStatus
    durationMs: number
    errorCode?: string
  }) {
    await this.db.insert(S.operationLogs).values({
      id: uid(),
      ...input,
      durationMs: Math.max(0, Math.trunc(input.durationMs)),
      errorCode: input.errorCode,
    })
  }

  /** 记录管理面安全事件；不接收请求体、路径、IP 或项目内容。 */
  async securityAudit(input: {
    actorType: 'user' | 'admin'
    actorId: string
    eventType: string
    resourceType?: string
    resourceId?: string
    result: 'success' | 'failed'
  }) {
    await this.db.insert(S.securityAudits).values({
      id: uid(),
      ...input,
    })
  }
}
