import type { RpcRequest } from '@rcm/protocol'
import { types } from 'node:util'
import pino from 'pino'

/** 本地运行元数据；允许附带异常和本地 HTTP 请求参数，不记录响应正文。 */
interface LogDetails {
  /** RPC ID 与 Server 的操作审计 ID 相同。 */
  requestId?: string
  /** 已验证的工具名及本机执行阶段。 */
  operation?: RpcRequest['operation']
  stage?: 'authorization' | 'validation' | 'approval' | 'execution'
  /** 固定错误码、耗时（毫秒）及安全的连接状态。 */
  code?: string
  durationMs?: number
  /** 失败命令的退出码与输出截断状态，不包含输出正文。 */
  exitCode?: number | null
  truncated?: boolean
  closeCode?: number
  httpStatus?: number
  retryInMs?: number
  port?: number
  workspaceCount?: number
  /** 设备启动时的 Runtime 版本。 */
  version?: string
  /** 本地 HTTP 方法、注册路由模板和响应状态。 */
  method?: string
  route?: string
  /** 客户端发送的原始请求 URL，通常为包含查询字符串的路径。 */
  url?: string
  /** Express 解析的查询参数和 JSON 请求体，仅写入本地日志。 */
  query?: unknown
  body?: unknown
  /** 原始异常或 Promise 拒绝值，只进入本地终端日志。 */
  err?: unknown
}

/** 序列化原始消息、堆栈和原因链；不展开 HTTP 客户端附带的请求及响应对象。 */
function serializeError(error: unknown): unknown {
  if (!types.isNativeError(error) && !(error instanceof Error)) return error
  const { type, message, stack, code, path, syscall } = pino.stdSerializers.err(error)
  const cause = error.cause
  return {
    type,
    message,
    stack,
    code: code ?? (cause instanceof Error && 'code' in cause ? cause.code : undefined),
    path: path ?? (cause instanceof Error && 'path' in cause ? cause.path : undefined),
    syscall: syscall ?? (cause instanceof Error && 'syscall' in cause ? cause.syscall : undefined),
  }
}

/** 只在启动时读取本机日志级别；无效设置按 info 处理。 */
const configuredLevel = process.env.RUNTIME_LOG_LEVEL
const level = configuredLevel === 'debug' || configuredLevel === 'error' ? configuredLevel : 'info'

/** 沿用本地日志字段格式，不附带 Pino 默认的主机名和进程 ID。 */
const options = {
  base: undefined,
  messageKey: 'event',
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: { level: (label: string) => ({ level: label }) },
  serializers: { err: serializeError },
}

const stdout = pino({ ...options, level }, process.stdout)
const stderr = pino({ ...options, level: 'error' }, process.stderr)

/** Runtime 本地诊断日志；与发送给 Server 的 RPC 错误及审计元数据相互独立。 */
export const logger = {
  /** 记录请求阶段、审批等待及重连等调试事件。 */
  debug(event: string, details?: LogDetails): void {
    stdout.debug(details ?? {}, event)
  },
  /** 记录启动、连接变更及成功完成的请求。 */
  info(event: string, details?: LogDetails): void {
    stdout.info(details ?? {}, event)
  },
  /** 记录故障、稳定错误码和可用的本地原始异常。 */
  error(event: string, details?: LogDetails): void {
    stderr.error(details ?? {}, event)
  },
  /** 进程即将退出时同步写入标准错误，避免管道中的最后一条日志丢失。 */
  fatal(event: string, details: LogDetails): void {
    pino({ ...options, level: 'error' }, pino.destination({ dest: 2, sync: true })).error(
      details,
      event,
    )
  },
}
