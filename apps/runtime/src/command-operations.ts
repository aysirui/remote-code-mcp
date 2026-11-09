import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { LocalCommand, LocalWorkspace } from './state'

/**
 * 内置命令仅保留项目任务。Git 状态与差异通过专用只读 MCP 工具执行，
 * 避免让简单 Git 查询走高权限的命令执行通道。
 */
const builtins: Record<string, LocalCommand> = {
  'git-log': {
    id: 'git-log',
    name: '最近 Git 提交',
    executable: 'git',
    args: ['--no-pager', 'log', '-n', '8', '--oneline'],
  },
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
  // 不允许使用 shell、脚本解释器命令行作为通用 Shell 绕过。若用户明确配置
  // 其他执行程序，仍须在 Runtime 本地审批，不能将其视为 OS 沙箱。
  const base = path.basename(executable).toLowerCase()
  if (
    /\.(?:bat|cmd|ps1|sh)$/i.test(base) ||
    /^(?:sh|bash|zsh|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/.test(base)
  )
    throw Error('SHELL_EXECUTABLE_DENIED')
  return { id, name: name.trim(), executable: executable.trim(), args: [...args] }
}

/** 只向 AI 提供命令元数据，不返回本地工作区根路径或私有凭据。 */
export function listCommands(w: LocalWorkspace): LocalCommand[] {
  return [...Object.values(builtins), ...(w.commands || []).map(validateLocalCommand)]
}

export function resolveCommand(w: LocalWorkspace, id: string): LocalCommand {
  const command = listCommands(w).find((item) => item.id === id)
  if (!command) throw Error('COMMAND_NOT_ALLOWED')
  return command
}

/** 在等待审批期间禁止本地用户替换命令定义（TOCTOU）。 */
export function commandFingerprint(command: LocalCommand): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex')
}

/**
 * 受控命令执行：远程只能选择本机已配置的 ID；工作目录固定为授权 Workspace。
 * 项目脚本和自定义可执行程序仍可能操作工作区以外的资源：须以低权限用户运行，
 * 且每次命令必须经本地明确审批。这里不承诺提供 OS 级沙箱。
 */
export async function runCheckedCommand(w: LocalWorkspace, id: string) {
  const selected = resolveCommand(w, id)
  const root = await fs.realpath(w.root)
  if (!(await fs.stat(root)).isDirectory()) throw Error('WORKSPACE_NOT_DIRECTORY')
  const isBuiltinPnpm = id in builtins && selected.executable === 'pnpm'
  const executable =
    process.platform === 'win32' && isBuiltinPnpm ? 'pnpm.cmd' : selected.executable
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
    const child = spawn(executable, selected.args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 启动 pnpm.cmd 需要 shell；其参数全部由不可变内置预设提供。
      shell: process.platform === 'win32' && isBuiltinPnpm,
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
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 20000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        command: id,
        exitCode: code,
        output: timedOut ? output + '\nCOMMAND_TIMEOUT' : output,
        truncated,
      })
    })
  })
}
