import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { LocalCommand, LocalWorkspace } from './state'

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

/**
 * 尽力终止命令及其子进程。
 * Unix 使用独立进程组；Windows 使用 taskkill /T。两者都不是不可逃逸的 OS 级进程容器。
 */
function terminateProcessTree(child: ReturnType<typeof spawn>, force = false) {
  if (!child.pid) return
  const signal = force ? 'SIGKILL' : 'SIGTERM'
  if (process.platform === 'win32') {
    // 首次只请求结束进程树；超时宽限期结束后再通过 /F 强制终止。
    const args = ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])]
    const killer = spawn('taskkill.exe', args, {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.on('error', () => child.kill(signal))
    killer.on('close', (code) => {
      if (code !== 0) child.kill(signal)
    })
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

/**
 * 执行本机预先登记的固定命令，远程调用只能提供命令 ID。
 * 当前实现提供审批、环境变量收敛和超时进程清理，但尚未构成 OS 级沙箱；
 * 命令仍可能访问当前 OS 用户有权访问的工作区外资源，不能将审批视为隔离措施。
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
  return new Promise<{
    command: string
    exitCode: number | null
    output: string
    truncated: boolean
  }>((resolve, reject) => {
    // Windows 的内置 pnpm 通过系统 .cmd 启动器运行；其参数来自固定内置定义，不接受远程 Shell 文本。
    const child = spawn(executable, selected.args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && isBuiltinPnpm,
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    let output = ''
    let truncated = false
    const limit = 48 * 1024
    const collect = (chunk: Buffer) => {
      const remaining = limit - Buffer.byteLength(output, 'utf8')
      if (remaining <= 0) {
        truncated = true
        return
      }
      const bytes = Buffer.from(chunk)
      if (bytes.length > remaining) truncated = true
      output += bytes.subarray(0, remaining).toString('utf8')
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    let timedOut = false
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    // 超时先发送 TERM，留出清理时间后再发送 KILL；子进程退出时清除两个计时器。
    const timer = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child)
      forceTimer = setTimeout(() => terminateProcessTree(child, true), 1500)
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      resolve({
        command: id,
        exitCode: code,
        output: timedOut ? output + '\nCOMMAND_TIMEOUT' : output,
        truncated,
      })
    })
  })
}
