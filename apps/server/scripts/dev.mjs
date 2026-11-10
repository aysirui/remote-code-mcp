import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const serverRoot = fileURLToPath(new URL('../', import.meta.url))
const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url))
const entryPath = fileURLToPath(new URL('../dist/main.js', import.meta.url))
let child
let closing = false
let restart = Promise.resolve()

async function stopChild() {
  const running = child
  child = undefined
  if (!running || running.exitCode !== null || running.signalCode !== null) return
  const exited = once(running, 'exit')
  running.kill()
  await exited
}

// 与生产构建读取同一份 tsconfig，通过 TypeScript 官方监听 API 编译。
const host = ts.createWatchCompilerHost(
  configPath,
  {},
  ts.sys,
  ts.createEmitAndSemanticDiagnosticsBuilderProgram,
  ts.createDiagnosticReporter(ts.sys, true),
  ts.createWatchStatusReporter(ts.sys, true),
)
const afterProgramCreate = host.afterProgramCreate
host.afterProgramCreate = (program) => {
  afterProgramCreate?.(program)
  const errors = ts
    .getPreEmitDiagnostics(program.getProgram())
    .some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  if (errors) return

  // 串行等待旧进程退出，避免重编译后端口尚未释放。
  restart = restart
    .then(async () => {
      await stopChild()
      if (closing) return
      child = spawn(process.execPath, ['--enable-source-maps', entryPath], {
        cwd: serverRoot,
        stdio: 'inherit',
      })
      child.on('error', (error) => console.error('开发服务启动失败：', error))
    })
    .catch((error) => console.error('开发服务重启失败：', error))
}

const watcher = ts.createWatchProgram(host)
async function shutdown() {
  if (closing) return
  closing = true
  watcher.close()
  await restart
  await stopChild()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
process.once('exit', () => child?.kill())
