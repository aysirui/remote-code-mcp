import { WebSocket } from 'ws'
import { runtimeVersion } from '../version'
import { publicWs, activeServer, serverWorkspaces, type Config } from '../workspace/state'
import { WriteApprovalQueue } from '../requests/write-approvals'
import { LocalEvents } from '../local/local-events'
import { handleGatewayMessage } from '../requests/request-handler'
import { logger, summarizeError } from '../logger'

/** 管理 Runtime 到当前 Server 的唯一连接、重连和工作区同步。 */
export class RuntimeConnection {
  private socket: WebSocket | undefined
  private online = false
  private stopped = false
  private connectionError = ''
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly config: Config,
    private readonly approvals: WriteApprovalQueue,
    private readonly events: LocalEvents,
  ) {}

  /** 本地 UI 使用的连接状态与工作区快照。 */
  status() {
    const server = activeServer(this.config)
    return {
      online: this.online,
      runtimeVersion,
      paired: !!server.deviceToken,
      deviceId: server.deviceId,
      serverId: server.id,
      gateway: server.gateway,
      name: this.config.name,
      serverName: server.name,
      paused: server.paused,
      connectionError: this.connectionError,
      servers: this.config.servers.map((item) => ({
        id: item.id,
        name: item.name,
        gateway: item.gateway,
        deviceId: item.deviceId,
        paired: !!item.deviceToken,
        paused: item.paused,
        workspaceCount: item.workspaces.filter((grant) => grant.authorized).length,
      })),
      workspaces: serverWorkspaces(this.config).map(publicWs),
    }
  }

  /** 主动断开连接，清空未完成审批与重连任务。 */
  disconnect() {
    this.approvals.cancelAll()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const previous = this.socket
    this.socket = undefined
    this.online = false
    this.connectionError = ''
    this.events.publish('status')
    previous?.close()
    if (previous) logger.info('gateway.disconnected')
  }

  /** 建立出站 WSS，设备凭据仅通过 TLS 或本机回环传输。 */
  connect() {
    const server = activeServer(this.config)
    if (this.stopped || server.paused || !server.deviceToken || this.socket) {
      logger.debug('gateway.connection.skipped', {
        code: this.stopped
          ? 'RUNTIME_STOPPED'
          : server.paused
            ? 'GATEWAY_PAUSED'
            : !server.deviceToken
              ? 'DEVICE_NOT_PAIRED'
              : 'CONNECTION_EXISTS',
      })
      return
    }
    this.connectionError = ''
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const wsURL = new URL(server.gateway)
    if (!['http:', 'https:'].includes(wsURL.protocol)) {
      logger.error('gateway.connection.rejected', { code: 'INVALID_GATEWAY_PROTOCOL' })
      return
    }
    if (wsURL.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(wsURL.hostname)) {
      logger.error('gateway.connection.rejected', { code: 'GATEWAY_HTTPS_REQUIRED' })
      return
    }
    wsURL.protocol = wsURL.protocol === 'https:' ? 'wss:' : 'ws:'
    wsURL.pathname = '/agent/connect'
    logger.debug('gateway.connecting')
    const connection = new WebSocket(wsURL.toString(), {
      headers: { Authorization: 'Bearer ' + server.deviceToken },
    })
    this.socket = connection
    connection.on('open', () => {
      if (this.socket !== connection) return
      this.online = true
      this.events.publish('status')
      logger.info('gateway.connected')
      void this.sync()
    })
    connection.on('message', async (raw) => {
      if (this.socket !== connection) return
      try {
        const response = await handleGatewayMessage(raw.toString(), {
          config: this.config,
          server,
          approvals: this.approvals,
          events: this.events,
          isConnected: () => this.socket === connection && connection.readyState === WebSocket.OPEN,
        })
        if (response && this.socket === connection && connection.readyState === WebSocket.OPEN) {
          const requestId = typeof response.id === 'string' ? response.id : undefined
          connection.send(JSON.stringify(response), (error) => {
            if (error)
              logger.error('gateway.response.failed', {
                requestId,
                code: 'DEVICE_SEND_FAILED',
              })
          })
        }
      } catch (error: unknown) {
        logger.error('gateway.message.failed', {
          code: 'GATEWAY_MESSAGE_FAILED',
          error: summarizeError(error),
        })
      }
    })
    connection.on('close', (code) => {
      if (this.socket !== connection) return
      this.approvals.cancelAll()
      if (code === 4003)
        this.connectionError = '此服务器上的设备绑定已撤销，请解除失效绑定后重新配对。'
      this.online = false
      this.events.publish('status')
      this.socket = undefined
      if (code === 4003) logger.error('gateway.closed', { closeCode: code, code: 'DEVICE_REVOKED' })
      else logger.info('gateway.closed', { closeCode: code })
      if (!this.stopped && !server.paused && server.deviceToken && !this.connectionError) {
        const retryInMs = 3500
        logger.debug('gateway.reconnect.scheduled', { retryInMs })
        this.reconnectTimer = setTimeout(() => this.connect(), retryInMs)
      }
    })
    connection.on('unexpected-response', (_request, response) => {
      response.resume()
      if (this.socket !== connection) return
      logger.error('gateway.handshake.failed', {
        code: 'GATEWAY_HANDSHAKE_FAILED',
        httpStatus: response.statusCode,
      })
      if (response.statusCode === 401 || response.statusCode === 403) {
        this.connectionError = '服务器拒绝设备凭据，请先解除失效绑定，再重新配对。'
        this.events.publish('status')
      }
      this.approvals.cancelAll()
      connection.terminate()
    })
    connection.on('error', (error) => {
      if (this.socket === connection)
        logger.error('gateway.socket.failed', {
          code: 'GATEWAY_SOCKET_FAILED',
          error: summarizeError(error),
        })
    })
  }

  /** 向已连接的 Server 发送最新工作区授权快照。 */
  async sync() {
    if (!this.online || this.socket?.readyState !== WebSocket.OPEN) return
    const workspaces = serverWorkspaces(this.config).map(publicWs)
    this.socket.send(JSON.stringify({ kind: 'hello', runtimeVersion, workspaces }), (error) => {
      if (error) logger.error('gateway.sync.failed', { code: 'DEVICE_SEND_FAILED' })
      else logger.debug('gateway.sync.sent', { workspaceCount: workspaces.length })
    })
  }

  /** 停止 Runtime 的连接管理，禁止后续自动重连。 */
  stop() {
    this.stopped = true
    this.disconnect()
  }
}
