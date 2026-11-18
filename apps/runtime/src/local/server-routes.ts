import type { Router, Response } from 'express'
import { save, addServer, selectServer, type Config, type ServerProfile } from '../workspace/state'
import { postGateway } from '../connection/gateway-client'
import { registerPairingRoutes, type Pairing } from './pairing-routes'
import type { WriteApprovalQueue } from '../requests/write-approvals'
import type { LocalEvents } from './local-events'

/** 服务器配置、设备配对与解除绑定共用的本地依赖。 */
export interface ServerRoutesContext {
  api: Router
  config: Config
  approvals: WriteApprovalQueue
  events: LocalEvents
  status: () => object
  disconnect: () => void
  connect: () => void
}

/** 注册服务器管理与设备绑定接口，返回工作区路由需要的公共操作。 */
export function registerServerRoutes(context: ServerRoutesContext) {
  const { api, config, approvals, events, status, disconnect, connect } = context
  const pairingRequests = new Map<string, { result: Pairing; expiresAt: number }>()
  const pairingBusy = new Set<string>()
  const requireServer = (id: unknown) => {
    const server = config.servers.find((item) => item.id === id)
    if (!server) throw Error('服务器不存在，请刷新页面')
    return server
  }
  const requireActiveServer = (id: unknown) => {
    const server = requireServer(id)
    if (server.id !== config.activeServerId) throw Error('当前服务器已切换，请刷新后重试')
    return server
  }
  const publishConfig = () => {
    events.publish('status')
    events.publish('workspaces')
  }
  /** 保留本地页面的错误响应，并将原始异常交给本地请求日志。 */
  const fail = (res: Response, error: unknown) => {
    res.locals.diagnosticError = error
    return res.status(400).json({ error: error instanceof Error ? error.message : '操作失败' })
  }
  const switchServer = async (id: string) => {
    const target = requireServer(id)
    if (config.activeServerId !== id || target.paused) {
      disconnect()
      selectServer(config, id)
      target.paused = false
    }
    await save(config)
    connect()
    publishConfig()
  }
  const revokeBinding = async (server: ServerProfile, localOnly = false) => {
    if (pairingBusy.has(server.id)) throw Error('正在配对，请稍后再试')
    // 服务端确认撤销成功前保留本地凭据，离线时不会丢失恢复连接所需的信息。
    if (server.deviceToken && !localOnly)
      await postGateway(server.gateway, '/api/device/unpair', {}, server.deviceToken)
    if (config.activeServerId === server.id) disconnect()
    server.deviceId = undefined
    server.deviceToken = undefined
    // 设备身份已经解除：清除该服务器的旧工作区授权，避免重新配对时继承上一设备权限。
    // 本机目录定义保留；用户重新配对后需要显式授权工作区。
    for (const grant of server.workspaces) {
      approvals.rejectWorkspace(grant.id)
    }
    server.workspaces = []
    pairingRequests.delete(server.id)
  }

  /** 兼容原入口：相同 origin 恢复原配置，不覆盖或清除任何已保存的配对。 */
  api.post('/config', async (req, res) => {
    try {
      const server = addServer(config, String(req.body.gateway), req.body.name)
      await switchServer(server.id)
      res.json(status())
    } catch (error: unknown) {
      fail(res, error)
    }
  })
  api.post('/servers', async (req, res) => {
    try {
      const server = addServer(config, String(req.body.gateway), String(req.body.name || ''))
      await save(config)
      publishConfig()
      res.json({ id: server.id })
    } catch (error: unknown) {
      fail(res, error)
    }
  })
  api.post('/servers/:id/activate', async (req, res) => {
    try {
      await switchServer(String(req.params.id))
      res.json(status())
    } catch (error: unknown) {
      fail(res, error)
    }
  })
  api.patch('/servers/:id', async (req, res) => {
    try {
      const server = requireServer(req.params.id)
      if (req.body.name !== undefined) {
        if (typeof req.body.name !== 'string' || !req.body.name.trim())
          throw Error('请输入服务器名称')
        server.name = req.body.name.trim().slice(0, 80)
      }
      if (req.body.paused !== undefined) {
        if (typeof req.body.paused !== 'boolean') throw Error('连接状态无效')
        server.paused = req.body.paused
        if (config.activeServerId === server.id) {
          disconnect()
          if (!server.paused) connect()
        }
      }
      await save(config)
      publishConfig()
      res.json(status())
    } catch (error: unknown) {
      fail(res, error)
    }
  })
  api.delete('/servers/:id', async (req, res) => {
    try {
      if (config.servers.length <= 1) throw Error('至少保留一个服务器配置')
      const server = requireServer(req.params.id)
      await revokeBinding(server)
      if (config.servers.length <= 1) throw Error('至少保留一个服务器配置')
      config.servers = config.servers.filter((item) => item !== server)
      if (config.activeServerId === server.id) selectServer(config, config.servers[0].id)
      await save(config)
      connect()
      publishConfig()
      res.json(status())
    } catch (error: unknown) {
      fail(res, error)
    }
  })

  registerPairingRoutes({
    api,
    config,
    requireServer,
    requireActiveServer,
    revokeBinding,
    pairingBusy,
    pairingRequests,
    connect,
    publishConfig,
    status,
    fail,
  })

  return { requireActiveServer, publishConfig, fail }
}
