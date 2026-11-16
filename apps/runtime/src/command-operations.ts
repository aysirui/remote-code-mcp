import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { LocalCommand, LocalWorkspace } from './state'
import { commandExecutionProvider } from './command-provider'

/** 内置命令只保留项目任务；所有 Git 操作必须通过独立 Git 工具域执行。 */
const builtins: Record<string, LocalCommand> = {
  typecheck: { id: 'typecheck', name: '类型检查', executable: 'pnpm', args: ['run', 'typecheck'] },
  test: { id: 'test', name: '运行测试', executable: 'pnpm', args: ['run', 'test'] },
  build: { id: 'build', name: '项目构建', executable: 'pnpm', args: ['run', 'build'] },
  format: { id: 'format', name: '格式化代码', executable: 'pnpm', args: ['run', 'format'] },
}

/** 自定义命令必须通过本地管理接口写入；远程调用只能携带命令 ID。 */
export function validateLocalCommand(input: unknown): LocalCommand {
  if (!input || typeof input !== 'object') throw Error('INVALID_COMMAND')
  const data = input as Record<string, unknown>
  const id = data.id,
    name = data.name,
    executable = data.executable,
    args = data.args
  if (
    typeof id !== 'string' ||
    !/^[a-z][a-z0-9_-]{1,39}$/.test(id) ||
    id === 'git-log' ||
    id in builtins ||
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 80 ||
    typeof executable !== 'string' ||
    !executable.trim() ||
    executable.length > 260 ||
    /[\r\n\0]/.test(executable) ||
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
  return { id, name: name.trim(), executable: executable.trim(), args: [...args] }
}

/** 只向 AI 提供命令元数据，不返回本地工作区根路径或私有凭据。 */
export function listCommands(w: LocalWorkspace): LocalCommand[] {
  // 旧版配置可能仍保存 git-log；过滤它，确保 Git 日志只能从 git.log 调用。
  return [
    ...Object.values(builtins),
    ...(w.commands || []).filter((item) => item.id !== 'git-log').map(validateLocalCommand),
  ]
}

/** 根据远程传入的命令 ID 查找本机登记项；未知 ID 一律拒绝，不接受远程 executable 或 args。 */
export function resolveCommand(w: LocalWorkspace, id: string): LocalCommand {
  const command = listCommands(w).find((item) => item.id === id)
  if (!command) throw Error('COMMAND_NOT_ALLOWED')
  return command
}

/** 在等待审批期间禁止本地用户替换命令定义（TOCTOU）。 */
export function commandFingerprint(command: LocalCommand): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex')
}

/** 命令默认最长运行 20 秒；超时后先温和终止，再强制清理进程树。 */
export const COMMAND_TIMEOUT_MS = 20_000

/** 没有经过验证的隔离后端时拒绝远程程序执行，审批不能替代文件及网络隔离。 */
export function assertCommandIsolation() {
  const capabilities = commandExecutionProvider.capabilities
  if (
    !capabilities.filesystemIsolation ||
    !capabilities.networkIsolation ||
    !capabilities.resourceLimits
  )
    throw Error('COMMAND_ISOLATION_REQUIRED')
}
/** 命令输出最多保留 48 KiB，避免大量日志占用 Runtime 内存或返回过大 RPC 响应。 */
const COMMAND_OUTPUT_LIMIT_BYTES = 48 * 1024

/**
 * 执行本机预先登记的固定命令，远程调用只能提供命令 ID。
 * 仅允许具备文件、网络与资源隔离能力的 Provider；当前普通 spawn 后端会被拒绝。
 *
 * @param w 已授权的本地工作区，命令工作目录固定为其真实根目录
 * @param id Runtime 本地登记的命令 ID
 * @param timeoutMs 内部测试可缩短超时；生产默认使用 COMMAND_TIMEOUT_MS
 */
export async function runCheckedCommand(
  w: LocalWorkspace,
  id: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
) {
  assertCommandIsolation()
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw Error('INVALID_COMMAND_TIMEOUT')
  const selected = resolveCommand(w, id)
  const root = await fs.realpath(w.root)
  if (!(await fs.stat(root)).isDirectory()) throw Error('WORKSPACE_NOT_DIRECTORY')
  const isBuiltinPnpm = id in builtins && selected.executable === 'pnpm'
  const executable =
    process.platform === 'win32' && isBuiltinPnpm ? 'pnpm.cmd' : selected.executable
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
  const result = await commandExecutionProvider.run({
    executable,
    args: selected.args,
    cwd: root,
    env,
    timeoutMs,
    outputLimitBytes: COMMAND_OUTPUT_LIMIT_BYTES,
    // 仅 Windows 内置 pnpm 需要通过系统 .cmd 启动器执行；自定义命令始终不启用 Shell。
    shell: process.platform === 'win32' && isBuiltinPnpm,
  })
  return {
    command: id,
    exitCode: result.exitCode,
    output: result.timedOut ? result.output + '\nCOMMAND_TIMEOUT' : result.output,
    truncated: result.truncated,
  }
}
