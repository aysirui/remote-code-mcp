import { WebSocket } from 'ws'
import { runtimeVersion } from './version'
import { randomBytes } from 'node:crypto'
import {
  load,
  publicWs,
  getWritePolicy,
  requiresWriteApproval,
  activeServer,
  serverWorkspaces,
  type Config,
} from './state'
import { execute } from './executors'
import { RpcRequestSchema, operationRequiresWrite, type RpcRequest } from '@rcm/protocol'
import { WriteApprovalQueue } from './write-approvals'
import { startLocalServer } from './local-server'
import { LocalEvents } from './local-events'
import { commandFingerprint, resolveCommand } from './command-operations'

const port = Number(process.env.RUNTIME_PORT || 18787)
const localKey = randomBytes(32).toString('base64url')
let config: Config
let socket: WebSocket | undefined
let online = false
let stopped = false
let connectionError = ''
let reconnectTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 每个工作区独立决定自动写入或逐次审批；断线时取消全部待审批任务。
 */
const events = new LocalEvents()
const approvals = new WriteApprovalQueue(() => events.publish('write-approvals'))

/** 断开设备 WebSocket，并取消所有尚未完成的写入审批。 */
function disconnect() {
  approvals.cancelAll()
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = undefined
  const previous = socket
  socket = undefined
  online = false
  connectionError = ''
  events.publish('status')
  previous?.close()
}
const stat = () => {
  const server = activeServer(config)
  return {
    online,
    runtimeVersion,
    paired: !!server.deviceToken,
    deviceId: server.deviceId,
    serverId: server.id,
    gateway: server.gateway,
    name: config.name,
    serverName: server.name,
    paused: server.paused,
    connectionError,
    servers: config.servers.map((item) => ({
      id: item.id,
      name: item.name,
      gateway: item.gateway,
      deviceId: item.deviceId,
      paired: !!item.deviceToken,
      paused: item.paused,
      workspaceCount: item.workspaces.filter((grant) => grant.authorized).length,
    })),
    workspaces: serverWorkspaces(config).map(publicWs),
  }
}
/** 建立出站 WSS，设备身份由 Bearer 凭据认证；重连时发送工作区快照。 */
function connect() {
  const server = activeServer(config)
  if (stopped || server.paused || !server.deviceToken || socket) return
  connectionError = ''
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = undefined
  const wsURL = new URL(server.gateway)
  if (!['http:', 'https:'].includes(wsURL.protocol)) return
  // Never send the device Bearer token over an unencrypted remote connection.
  if (wsURL.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(wsURL.hostname)) {
    console.error('HTTPS gateway required for remote devices')
    return
  }
  wsURL.protocol = wsURL.protocol === 'https:' ? 'wss:' : 'ws:'
  wsURL.pathname = '/agent/connect'
  const connection = new WebSocket(wsURL.toString(), {
    headers: { Authorization: 'Bearer ' + server.deviceToken },
  })
  socket = connection
  connection.on('open', () => {
    if (socket !== connection) return
    online = true
    events.publish('status')
    connection.send(
      JSON.stringify({
        kind: 'hello',
        runtimeVersion,
        workspaces: serverWorkspaces(config, server).map(publicWs),
      }),
    )
    console.log('Gateway connected')
  })
  connection.on('message', async (raw) => {
    if (socket !== connection) return
    let req: RpcRequest | undefined
    try {
      const parsed = RpcRequestSchema.parse(JSON.parse(raw.toString()))
      req = parsed
      const workspace = serverWorkspaces(config, server).find((x) => x.id === parsed.workspaceId)
      if (!workspace) throw Error('WORKSPACE_NOT_FOUND')
      const accessSnapshot = JSON.stringify(workspace)
      if (parsed.deadlineAt < Date.now()) throw Error('REQUEST_EXPIRED')
      if (operationRequiresWrite(parsed.operation)) {
        // 读写权限是任何写入策略的前置条件，未授权写入不进入审批队列。
        if (!workspace.enabled || !workspace.permissions.read || !workspace.permissions.write)
          throw Error('WORKSPACE_WRITE_NOT_ALLOWED')

        const policy = getWritePolicy(workspace)
        // 将本次请求对应的命令定义绑定到审批前的快照，防止审批期间修改命令。
        const approvedCommand =
          parsed.operation === 'command.run'
            ? commandFingerprint(
                resolveCommand(
                  workspace,
                  String((parsed.payload as { command?: unknown }).command),
                ),
              )
            : undefined
        // 删除操作和项目命令永远要求本地逐次审批，不能被自动写入策略绕过。
        const alwaysApprove =
          parsed.operation === 'file.delete' || parsed.operation === 'command.run'
        if (alwaysApprove || requiresWriteApproval(workspace)) {
          // 逐次审批模式最多等待 30 秒；默认及旧版工作区保持这一安全行为。
          const approved = await approvals.request(parsed, workspace)
          if (!approved) throw Error('WRITE_APPROVAL_DENIED_OR_EXPIRED')
        }

        // 自动写入也不能绕过连接、时限、工作区和写入策略重新验证。
        if (socket !== connection || connection.readyState !== WebSocket.OPEN)
          throw Error('CONNECTION_REPLACED')
        if (parsed.deadlineAt < Date.now()) throw Error('REQUEST_EXPIRED')
        const currentWorkspace = serverWorkspaces(config, server).find(
          (w) => w.id === parsed.workspaceId,
        )
        if (
          JSON.stringify(currentWorkspace) !== accessSnapshot ||
          !workspace.enabled ||
          !workspace.permissions.read ||
          !workspace.permissions.write ||
          getWritePolicy(workspace) !== policy ||
          (approvedCommand !== undefined &&
            commandFingerprint(
              resolveCommand(workspace, String((parsed.payload as { command?: unknown }).command)),
            ) !== approvedCommand)
        )
          throw Error('WORKSPACE_PERMISSION_REVOKED')
      }
      // 非写操作继续走 execute 内的工作区权限验证。
      const data = await execute(workspace, parsed)
      if (connection.readyState === WebSocket.OPEN)
        connection.send(JSON.stringify({ kind: 'response', id: parsed.id, success: true, data }))
    } catch (e: unknown) {
      if (req?.id && connection.readyState === WebSocket.OPEN) {
        const message = e instanceof Error ? e.message : String(e)
        connection.send(
          JSON.stringify({
            kind: 'response',
            id: req.id,
            success: false,
            error: { code: 'EXECUTION_FAILED', message },
          }),
        )
      }
    }
  })
  connection.on('close', (code) => {
    if (socket !== connection) return
    if (code === 4003) connectionError = '此服务器上的设备绑定已撤销，请解除失效绑定后重新配对。'
    online = false
    events.publish('status')
    socket = undefined
    if (!stopped && !server.paused && server.deviceToken && !connectionError)
      reconnectTimer = setTimeout(connect, 3500)
  })
  connection.on('unexpected-response', (_request, response) => {
    response.resume()
    if (socket !== connection) return
    if (response.statusCode === 401 || response.statusCode === 403) {
      connectionError = '服务器拒绝设备凭据，请先解除失效绑定，再重新配对。'
      events.publish('status')
    }
    connection.terminate()
  })
  connection.on('error', (e) => console.error('Gateway WebSocket', e.message))
}
/** 在连接有效时向 Gateway 同步本地授权状态。 */
async function sync() {
  if (online && socket?.readyState === WebSocket.OPEN)
    socket.send(
      JSON.stringify({
        kind: 'hello',
        runtimeVersion,
        workspaces: serverWorkspaces(config).map(publicWs),
      }),
    )
}
/** 加载 Runtime 配置，启动本地 UI，连接 Gateway 并注册退出清理。 */
async function boot() {
  config = await load()
  const httpServer = startLocalServer({
    port,
    localKey,
    config,
    approvals,
    events,
    status: stat,
    disconnect,
    connect,
    sync,
  })
  const shutdown = () => {
    if (stopped) return
    stopped = true
    disconnect()
    httpServer.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  connect()
}
boot().catch((e) => {
  console.error(e)
  process.exit(1)
})
