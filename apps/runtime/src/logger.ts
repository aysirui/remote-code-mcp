import type { RpcRequest } from '@rcm/protocol'
import { types } from 'node:util'
import pino from 'pino'
import pretty from 'pino-pretty'

/** 本地运行诊断，可附带请求参数、命令结果和异常；不记录 HTTP 响应正文。 */
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
  /** 原始 RPC 入参只在 Runtime 本地记录，不进入审计。 */
  payload?: unknown
  /** 实际执行的命令、参数、工作目录及本机执行时限（毫秒），仅用于本地日志。 */
  command?: {
    id?: string
    executable: string
    args: string[]
    cwd: string
    timeoutMs: number
  }
  /** 本机命令收集到的 stdout / stderr 合并输出及超时状态。 */
  output?: string
  timedOut?: boolean
  /** 已捕获错误的业务摘要，不包含堆栈。 */
  error?: unknown
  /** 显式记录原始异常或未处理的拒绝值，只进入本地终端日志。 */
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

/** 提取原始消息和系统字段，供可恢复的失败使用，不记录堆栈或请求对象。 */
export function summarizeError(error: unknown): unknown {
  if (!types.isNativeError(error) && !(error instanceof Error))
    return typeof error === 'string' || error === undefined ? error : { type: typeof error }
  const cause = error.cause
  const systemError = types.isNativeError(cause) || cause instanceof Error ? cause : error
  return {
    message: systemError === error ? error.message : `${error.message}: ${systemError.message}`,
    code: 'code' in systemError ? systemError.code : undefined,
    path: 'path' in systemError ? systemError.path : undefined,
    syscall: 'syscall' in systemError ? systemError.syscall : undefined,
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

/** 首行只显示时间、级别和事件；交由 pino-pretty 缩进展示全部已记录字段及异常。 */
const formatTerminalLine = pretty.prettyFactory({
  messageKey: 'event',
  timestampKey: 'timestamp',
  translateTime: 'SYS:HH:MM:ss.l',
  colorize: false,
})

/** 每个输出流独立判断是否连接终端；管道和重定向保留原有 JSON。 */
function outputOptions(isTTY: boolean | undefined) {
  return isTTY ? { ...options, hooks: { streamWrite: formatTerminalLine } } : options
}

const stdout = pino({ ...outputOptions(process.stdout.isTTY), level }, process.stdout)
const stderrOptions = { ...outputOptions(process.stderr.isTTY), level: 'error' }
const stderr = pino(stderrOptions, process.stderr)

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
    pino(stderrOptions, pino.destination({ dest: 2, sync: true })).error(details, event)
  },
}
