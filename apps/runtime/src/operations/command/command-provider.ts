import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { StringDecoder } from 'node:string_decoder'

/** 保留参数数组语义，并处理 Windows 的 pnpm.cmd 等命令启动器。 */
const spawnCommand = createRequire(__filename)('cross-spawn') as typeof spawn

/** Command 执行请求仅由 Runtime 内部构造，不直接接收远程 MCP 入参。 */
export interface CommandExecutionRequest {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  outputLimitBytes: number
}

/** 执行结果只返回有限长度的合并输出，不暴露子进程对象或本地运行环境。 */
export interface CommandExecutionResult {
  /** 进程退出码，信号终止或无法取得退出码时为 null。 */
  exitCode: number | null
  /** 已收集的标准输出和标准错误，UTF-8 字节数不超过请求上限。 */
  output: string
  /** 输出是否因大小限制而截断。 */
  truncated: boolean
  /** 进程是否在执行时限内未退出；优先于退出码解释结果。 */
  timedOut: boolean
}

/** 能力声明明确区分进程管理与真正的 OS 隔离，避免将普通 spawn 误报为沙箱。 */
export interface CommandExecutionCapabilities {
  processTreeTermination: 'best-effort'
  filesystemIsolation: false
  networkIsolation: false
  resourceLimits: false
}

/** 执行后端接口为后续接入 OS 沙箱保留边界；当前实现仍是普通子进程执行。 */
export interface CommandExecutionProvider {
  readonly capabilities: CommandExecutionCapabilities
  run(request: CommandExecutionRequest): Promise<CommandExecutionResult>
}

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
 * 当前普通 spawn 后端：负责进程启动、输出限额和超时清理，不提供文件或网络隔离。
 * 命令使用 Runtime 账号权限；是否执行由本地策略及单次审批决定。
 */
export class SpawnCommandExecutionProvider implements CommandExecutionProvider {
  readonly capabilities: CommandExecutionCapabilities = {
    processTreeTermination: 'best-effort',
    filesystemIsolation: false,
    networkIsolation: false,
    resourceLimits: false,
  }

  run(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    return new Promise((resolve, reject) => {
      const child = spawnCommand(request.executable, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
      const chunks: Buffer[] = []
      let collectedBytes = 0
      let truncated = false
      const collect = (chunk: Buffer) => {
        const remaining = request.outputLimitBytes - collectedBytes
        if (chunk.length > remaining) truncated = true
        if (remaining > 0) {
          const collected = chunk.subarray(0, remaining)
          chunks.push(collected)
          collectedBytes += collected.length
        }
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)

      let timedOut = false
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined
      // 先尝试结束进程树，再强制结束；子进程继承的管道仍不关闭时也要及时返回超时结果。
      const timer = setTimeout(() => {
        timedOut = true
        terminateProcessTree(child)
        forceTimer = setTimeout(() => {
          terminateProcessTree(child, true)
          cleanupTimer = setTimeout(() => {
            child.off('close', finish)
            child.stdout?.destroy()
            child.stderr?.destroy()
            child.unref()
            finish(child.exitCode)
          }, 1500)
        }, 1500)
      }, request.timeoutMs)

      /** 统一释放等待计时器，保留结束前已收集的输出。 */
      function finish(code: number | null) {
        clearTimeout(timer)
        if (forceTimer) clearTimeout(forceTimer)
        if (cleanupTimer) clearTimeout(cleanupTimer)
        const decoded = Buffer.from(Buffer.concat(chunks, collectedBytes).toString('utf8'))
        // 不完整或非法的 UTF-8 字节可能扩展成替代字符；再次按字节限长，不切断字符。
        const output = new StringDecoder('utf8').write(
          decoded.subarray(0, request.outputLimitBytes),
        )
        resolve({
          exitCode: code,
          output,
          truncated: truncated || decoded.length > request.outputLimitBytes,
          timedOut,
        })
      }

      child.on('error', (error) => {
        if (timedOut) return
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', finish)
    })
  }
}

/** 默认在本机运行；此能力不承诺文件、网络或资源隔离。 */
export const commandExecutionProvider: CommandExecutionProvider =
  new SpawnCommandExecutionProvider()
