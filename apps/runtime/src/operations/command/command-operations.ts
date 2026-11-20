import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { LocalCommand, LocalWorkspace } from '../../workspace/state'
import { commandExecutionProvider } from './command-provider'
import {
  CommandRunInputSchema,
  COMMAND_MAX_TIMEOUT_MS,
  COMMAND_OUTPUT_LIMIT_BYTES,
  sanitizeCommandAudit,
  type CommandAudit,
  type CommandResultErrorCode,
  type CommandRunInput,
  type ToolOutput,
} from '@rcm/protocol'
import { policyForOperation } from '../../workspace/state'
import { logger, summarizeError } from '../../logger'

/** 内置命令只保留项目任务；所有 Git 操作必须通过独立 Git 工具域执行。 */
const builtins: Record<string, LocalCommand> = {
  typecheck: {
    id: 'typecheck',
    name: '类型检查',
    executable: 'pnpm',
    args: ['run', 'typecheck'],
    timeoutMs: 600_000,
  },
  test: {
    id: 'test',
    name: '运行测试',
    executable: 'pnpm',
    args: ['run', 'test'],
    timeoutMs: 600_000,
  },
  build: {
    id: 'build',
    name: '项目构建',
    executable: 'pnpm',
    args: ['run', 'build'],
    timeoutMs: 600_000,
  },
  format: {
    id: 'format',
    name: '格式化代码',
    executable: 'pnpm',
    args: ['run', 'format'],
    timeoutMs: 120_000,
  },
}

/** 将程序和参数按原顺序显示为一行；有空格或特殊字符的参数以引号区分，不作为 Shell 脚本执行。 */
export function formatApprovalCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args]
    .map((part) => (/^[a-zA-Z0-9_./:@=-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(' ')
}

/** 只有本机内置固定命令允许在通知渠道展示完整命令。 */
export function commandCanBeDisplayedInApproval(commandId: string): boolean {
  return Object.hasOwn(builtins, commandId)
}

/** 自定义登记命令通过本地管理接口保存；远程临时命令不写入注册表。 */
export function validateLocalCommand(input: unknown): LocalCommand {
  if (!input || typeof input !== 'object') throw Error('INVALID_COMMAND')
  const data = input as Record<string, unknown>
  const id = data.id,
    name = data.name,
    executable = data.executable,
    args = data.args,
    timeoutMs = data.timeoutMs
  if (
    typeof id !== 'string' ||
    !/^[a-z][a-z0-9_-]{1,39}$/.test(id) ||
    id in builtins ||
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 80 ||
    typeof executable !== 'string' ||
    !executable.trim() ||
    executable.length > 260 ||
    /[\r\n\0]/.test(executable) ||
    (timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) ||
        (timeoutMs as number) < 1000 ||
        (timeoutMs as number) > COMMAND_MAX_TIMEOUT_MS)) ||
    !Array.isArray(args) ||
    args.length > 20 ||
    !args.every((arg) => typeof arg === 'string' && arg.length <= 500 && !/[\r\n\0]/.test(arg))
  )
    throw Error('INVALID_COMMAND')
  // 禁止 Shell、脚本解释器和 Git 作为自定义入口，避免通过命令白名单绕过独立 Git 工具域。
  const base = path.basename(executable).toLowerCase()
  if (
    /\.(?:bat|cmd|ps1|sh)$/i.test(base) ||
    /^(?:sh|bash|zsh|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|git(?:\.exe|\.cmd)?)$/.test(
      base,
    )
  )
    throw Error('SHELL_EXECUTABLE_DENIED')
  return {
    id,
    name: name.trim(),
    executable: executable.trim(),
    args: [...args],
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
  }
}

/** 只向 AI 提供命令元数据，不返回本地工作区根路径或私有凭据。 */
export function listCommands(w: LocalWorkspace): LocalCommand[] {
  return [...Object.values(builtins), ...(w.commands || []).map(validateLocalCommand)]
}

/** 根据命令 ID 查找本机登记项；未知 ID 必须改用临时命令形式提供完整程序和参数。 */
export function resolveCommand(w: LocalWorkspace, id: string): LocalCommand {
  const command = listCommands(w).find((item) => item.id === id)
  if (!command) throw Error('COMMAND_NOT_ALLOWED')
  return command
}

/** 临时命令即使与登记项相同，也必须审批，且不能覆盖登记命令的程序或参数。 */
export function resolveCommandRequest(w: LocalWorkspace, input: unknown) {
  const payload = CommandRunInputSchema.parse(input)
  if ('command' in payload) return { command: resolveCommand(w, payload.command), registered: true }
  const command = validateLocalCommand({
    id: 'one-time',
    name: '未登记命令（仅本次）',
    executable: payload.executable,
    args: payload.args,
  })
  return { command, registered: false }
}

/** 本地禁止优先；临时命令在 allow 下仍需逐次审批。 */
export function commandRequiresApproval(w: LocalWorkspace, input: unknown): boolean {
  return (
    policyForOperation(w, 'command.run') === 'approval' ||
    !resolveCommandRequest(w, input).registered
  )
}

/** 在等待审批期间禁止本地用户替换命令定义（TOCTOU）。 */
export function commandFingerprint(command: LocalCommand): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex')
}

/** 未设置独立超时的登记项及临时命令默认执行 60 秒。 */
export const COMMAND_TIMEOUT_MS = 60_000

/** 已启动命令失败，保留限长结果以回复发起调用的客户端；Server 不持久化结果。 */
export class CommandResultError extends Error {
  /** @param code 稳定失败码。 @param result 已校验的、限长的命令结果。 */
  constructor(
    code: CommandResultErrorCode,
    readonly result: ToolOutput<'command.run'>,
  ) {
    super(code)
  }
}

/**
 * 以 Runtime 账号权限执行登记命令或经过单次审批的临时命令，不提供 OS 隔离。
 *
 * @param w 已授权的本地工作区，命令工作目录固定为其真实根目录
 * @param input 登记命令 ID 或临时程序及参数
 * @param approvalResourceHash 本机审批生成的命令指纹，不接受远程传入
 * @param timeoutMs 内部测试可覆盖超时；生产优先使用本机登记项的 timeoutMs
 * @param onExecution 执行前接收脱敏审计元数据，不包含命令输出
 * @param requestId 可选 RPC ID，仅用于关联本地命令日志
 * @returns 退出码、限长输出及供 RPC 层区分失败原因的超时状态
 */
export async function runCheckedCommand(
  w: LocalWorkspace,
  input: CommandRunInput,
  approvalResourceHash?: string,
  timeoutMs?: number,
  onExecution?: (command: CommandAudit) => void,
  requestId?: string,
) {
  if (!w.enabled || !w.permissions.read || !w.permissions.write) throw Error('PERMISSION_DENIED')
  if (policyForOperation(w, 'command.run') === 'deny') throw Error('POLICY_DENIED')
  const { command: selected } = resolveCommandRequest(w, input)
  if (commandRequiresApproval(w, input) && approvalResourceHash !== commandFingerprint(selected))
    throw Error('COMMAND_APPROVAL_REQUIRED')
  const effectiveTimeoutMs = timeoutMs ?? selected.timeoutMs ?? COMMAND_TIMEOUT_MS
  if (
    !Number.isSafeInteger(effectiveTimeoutMs) ||
    effectiveTimeoutMs <= 0 ||
    effectiveTimeoutMs > COMMAND_MAX_TIMEOUT_MS
  )
    throw Error('INVALID_COMMAND_TIMEOUT')
  const root = await fs.realpath(w.root)
  if (!(await fs.stat(root)).isDirectory()) throw Error('WORKSPACE_NOT_DIRECTORY')
  // 只向命令传递必要的运行环境变量，避免继承 Runtime 的凭据及代理等敏感配置。
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
  }
  onExecution?.(sanitizeCommandAudit(selected))
  // 本地日志保留实际执行信息；审计回调仍只接收独立的脱敏对象。
  const logContext = {
    requestId,
    command: {
      id: 'command' in input ? input.command : undefined,
      executable: selected.executable,
      args: selected.args,
      cwd: root,
      timeoutMs: effectiveTimeoutMs,
    },
  }
  const startedAt = Date.now()
  logger.info('command.started', logContext)
  const result = await commandExecutionProvider
    .run({
      executable: selected.executable,
      args: selected.args,
      cwd: root,
      env,
      timeoutMs: effectiveTimeoutMs,
      outputLimitBytes: COMMAND_OUTPUT_LIMIT_BYTES,
    })
    .catch((cause: unknown) => {
      logger.error('command.start_failed', {
        ...logContext,
        code: 'COMMAND_START_FAILED',
        durationMs: Date.now() - startedAt,
        error: summarizeError(cause),
      })
      throw Error('COMMAND_START_FAILED', { cause })
    })
  const details = { ...logContext, ...result, durationMs: Date.now() - startedAt }
  if (result.timedOut || result.exitCode !== 0) logger.error('command.failed', details)
  else logger.info('command.completed', details)
  return {
    command: 'command' in input ? input.command : selected.executable,
    exitCode: result.exitCode,
    output: result.output,
    truncated: result.truncated,
    timedOut: result.timedOut,
  }
}
