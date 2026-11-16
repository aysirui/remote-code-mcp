import { randomBytes } from 'node:crypto'
import { load } from './workspace/state'
import { WriteApprovalQueue } from './requests/write-approvals'
import { startLocalServer } from './local/local-server'
import { LocalEvents } from './local/local-events'
import { RuntimeConnection } from './connection/runtime-connection'

/** Runtime 组合入口：装配本地 API、审批队列和 Gateway 连接。 */
async function boot() {
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
    connection.stop()
    httpServer.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  connection.connect()
}
boot().catch((error) => {
  console.error(error)
  process.exit(1)
})
