import { randomBytes } from 'node:crypto'
import { load } from './workspace/state'
import { WriteApprovalQueue } from './requests/write-approvals'
import { startLocalServer } from './local/local-server'
import { LocalEvents } from './local/local-events'
import { RuntimeConnection } from './connection/runtime-connection'
import { runtimeVersion } from './version'
import { logger } from './logger'

/** 记录无法继续运行的异常后以非零状态退出，不让进程带着未知状态继续执行。 */
function exitOnFailure(code: string, error: unknown): never {
  try {
    logger.fatal('runtime.fatal', { code, err: error })
  } finally {
    process.exit(1)
  }
}

process.once('uncaughtException', (error, origin) =>
  exitOnFailure(
    origin === 'unhandledRejection' ? 'UNHANDLED_REJECTION' : 'UNCAUGHT_EXCEPTION',
    error,
  ),
)
process.once('unhandledRejection', (reason) => exitOnFailure('UNHANDLED_REJECTION', reason))

/** Runtime 组合入口：装配本地 API、审批队列和 Server 连接。 */
async function boot() {
  logger.info('runtime.starting', { version: runtimeVersion })
  const config = await load()
  const events = new LocalEvents()
  const approvals = new WriteApprovalQueue(() => events.publish('write-approvals'))
  const connection = new RuntimeConnection(config, approvals, events)
  const httpServer = startLocalServer({
    port: Number(process.env.RUNTIME_PORT || 18787),
    localKey: randomBytes(32).toString('base64url'),
    config,
    approvals,
    events,
    status: () => connection.status(),
    disconnect: () => connection.disconnect(),
    connect: () => connection.connect(),
    sync: () => connection.sync(),
  })
  let stopped = false
  const shutdown = () => {
    if (stopped) return
    stopped = true
    logger.info('runtime.stopping')
    connection.stop()
    httpServer.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  httpServer.once('error', (error) => {
    logger.error('runtime.local_server.failed', {
      code: 'LOCAL_SERVER_START_FAILED',
      err: error,
    })
    process.exitCode = 1
    shutdown()
  })
  connection.connect()
}
void boot().catch((error: unknown) => exitOnFailure('RUNTIME_START_FAILED', error))
