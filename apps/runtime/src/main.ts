import { WebSocket } from 'ws'
import { runtimeVersion } from './version'
import { createHash, randomBytes } from 'node:crypto'
import {
  load,
  publicWs,
  policyForOperation,
  activeServer,
  serverWorkspaces,
  type Config,
} from './state'
import { execute, validateOperationSafety } from './executors'
import {
  RpcRequestSchema,
  operationRequiresWrite,
  operationRequiresLocalApproval,
  type RpcRequest,
  type CommandAudit,
} from '@rcm/protocol'
import { WriteApprovalQueue } from './write-approvals'
import { startLocalServer } from './local-server'
import { LocalEvents } from './local-events'
import {
  commandFingerprint,
  resolveCommandRequest,
  commandRequiresApproval,
} from './command-operations'
import { gitApprovalContext } from './git-operations'
import { inspectDeleteTarget, HIGH_RISK_DELETE_THRESHOLD } from './file-operations'
import { resolveSafe } from './path-safety'

const port = Number(process.env.RUNTIME_PORT || 18787)
const localKey = randomBytes(32).toString('base64url')
const approvalRequestHash = (req: RpcRequest) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        workspaceId: req.workspaceId,
        operation: req.operation,
        payload: req.payload,
      }),
    )
    .digest('hex')
let config: Config
let socket: WebSocket | undefined
let online = false
let stopped = false
let connectionError = ''
let reconnectTimer: ReturnType<typeof setTimeout> | undefined

/** 审批上下文仅驻留 Runtime 内存；断线时取消全部待审批任务。 */
const events = new LocalEvents()
const approvals = new WriteApprovalQueue(() => events.publish('write-approvals'))

/** 断开设备 WebSocket，并取消所有尚未完成的操作审批。 */
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
  // 设备 Bearer Token 只允许通过 TLS 传输；明文 HTTP 仅用于本机开发回环地址。
  const wsURL = new URL(server.gateway)
  if (!['http:', 'https:'].includes(wsURL.protocol)) return
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
    let commandAudit: CommandAudit | undefined
    try {
      const parsed = RpcRequestSchema.parse(JSON.parse(raw.toString()))
      req = parsed
      const workspace = serverWorkspaces(config, server).find((x) => x.id === parsed.workspaceId)
      if (!workspace) throw Error('WORKSPACE_NOT_FOUND')
      const accessSnapshot = JSON.stringify(workspace)
      if (parsed.deadlineAt < Date.now()) throw Error('REQUEST_EXPIRED')
      // 工作区启用状态和读写权限是所有工具策略的前置条件，不能由 approval 或 allow 覆盖。
      if (
        !workspace.enabled ||
        !workspace.permissions.read ||
        (operationRequiresWrite(parsed.operation) && !workspace.permissions.write)
      )
        throw Error('PERMISSION_DENIED')

      // 先计算本地策略；deny 直接拒绝，approval 必须等待本机用户确认。
      const policy = policyForOperation(workspace, parsed.operation)
      if (policy === 'deny') throw Error('POLICY_DENIED')

      // 权限检查通过后，Hard Deny 先于审批执行。
      await validateOperationSafety(workspace, parsed)
      // 在审批前固定命令定义的指纹，防止用户等待期间修改命令可执行程序或参数。
      const approvedCommand =
        parsed.operation === 'command.run'
          ? commandFingerprint(resolveCommandRequest(workspace, parsed.payload).command)
          : undefined

      let approvalResourceHash: string | undefined
      // 文件删除根据本机真实目录项数量判断风险；工具名称本身不再触发强制审批。
      let highRiskDelete = false
      if (parsed.operation === 'file.delete') {
        const payload = parsed.payload as { path: string; recursive: boolean }
        const target = await resolveSafe(workspace, payload.path)
        const snapshot = await inspectDeleteTarget(target)
        highRiskDelete = payload.recursive && snapshot.entryCount > HIGH_RISK_DELETE_THRESHOLD
      }
      // 本地策略要求审批、Git 高风险写操作或本机识别的高危删除均需确认。
      // 普通文件删除在 allow 下直接执行；审批队列最多等待五分钟。
      if (
        policy === 'approval' ||
        (parsed.operation === 'command.run' &&
          commandRequiresApproval(workspace, parsed.payload)) ||
        operationRequiresLocalApproval(parsed.operation) ||
        highRiskDelete
      ) {
        const expectedApprovalHash = approvalRequestHash(parsed)
        const decision = await approvals.request(parsed, workspace)
        if (!decision.approved) throw Error('APPROVAL_DENIED_OR_EXPIRED')
        approvalResourceHash = decision.resourceHash
        if (
          decision.requestHash !== expectedApprovalHash ||
          approvalRequestHash(parsed) !== expectedApprovalHash
        )
          throw Error('APPROVAL_REQUEST_CHANGED')
        if (decision.resourceHash !== undefined) {
          if (parsed.operation === 'file.delete') {
            const payload = parsed.payload as { path: string }
            const target = await resolveSafe(workspace, payload.path)
            const current = await inspectDeleteTarget(target)
            if (current.fingerprint !== decision.resourceHash)
              throw Error('DELETE_TARGET_CHANGED_DURING_APPROVAL')
          } else if (parsed.operation === 'command.run') {
            if (
              commandFingerprint(resolveCommandRequest(workspace, parsed.payload).command) !==
              decision.resourceHash
            )
              throw Error('COMMAND_CHANGED_DURING_APPROVAL')
          } else {
            const current = await gitApprovalContext(workspace, parsed.operation, parsed.payload)
            if (current.fingerprint !== decision.resourceHash)
              throw Error('GIT_STATE_CHANGED_DURING_APPROVAL')
          }
        }
      }

      // 审批完成后重新验证连接、时限、工作区授权和策略，防止等待期间权限被撤销。
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
        (operationRequiresWrite(parsed.operation) && !workspace.permissions.write) ||
        policyForOperation(workspace, parsed.operation) !== policy ||
        (approvedCommand !== undefined &&
          commandFingerprint(resolveCommandRequest(workspace, parsed.payload).command) !==
            approvedCommand)
      )
        throw Error('WORKSPACE_PERMISSION_REVOKED')
      // execute 内部再次校验工作区权限、策略、参数和路径，形成独立的执行层防线。
      const data = await execute(workspace, parsed, approvalResourceHash, (command) => {
        commandAudit = command
      })
      if (connection.readyState === WebSocket.OPEN)
        connection.send(
          JSON.stringify({ kind: 'response', id: parsed.id, success: true, data, commandAudit }),
        )
    } catch (e: unknown) {
      if (req?.id && connection.readyState === WebSocket.OPEN) {
        const message = e instanceof Error ? e.message : String(e)
        connection.send(
          JSON.stringify({
            kind: 'response',
            id: req.id,
            success: false,
            commandAudit,
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
