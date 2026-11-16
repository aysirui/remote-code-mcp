import type { Router, Response } from 'express'
import { save, type Config, type ServerProfile } from '../workspace/state'
import { postGateway } from '../connection/gateway-client'

/** 配对路由依赖由服务器管理模块注入；配对状态只在 Runtime 内存中保存。 */
export interface PairingRoutesContext {
  api: Router
  config: Config
  requireServer: (id: unknown) => ServerProfile
  requireActiveServer: (id: unknown) => ServerProfile
  revokeBinding: (server: ServerProfile, localOnly?: boolean) => Promise<void>
  pairingBusy: Set<string>
  pairingRequests: Map<string, { result: Pairing; expiresAt: number }>
  connect: () => void
  publishConfig: () => void
  status: () => object
  fail: (res: Response, error: unknown) => Response
}

export type Pairing = {
  id: string
  code: string
  privateSecret: string
  activationUrl: string
  expiresIn: number
}

/** 注册设备配对和解除绑定接口，保留原有并发保护及凭据清理顺序。 */
export function registerPairingRoutes(context: PairingRoutesContext) {
  const {
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
  } = context
  /** 配对始终绑定具体服务器；重复点击复用仍有效的配对码。 */
  api.post('/pair/start', async (req, res) => {
    let server: ServerProfile | undefined
    let acquired = false
    try {
      server = requireActiveServer(req.body.serverId)
      if (server.deviceToken) throw Error('此服务器已配对，无需重新绑定')
      if (pairingBusy.has(server.id)) throw Error('正在配对，请稍后再试')
      const previous = pairingRequests.get(server.id)
      if (previous && previous.expiresAt > Date.now()) {
        res.json({ ...previous.result, serverId: server.id })
        return
      }
      pairingBusy.add(server.id)
      acquired = true
      const result = await postGateway<Pairing>(server.gateway, '/api/device/pairing/start', {
        name: config.name,
        platform: process.platform,
      })
      pairingRequests.set(server.id, { result, expiresAt: Date.now() + result.expiresIn * 1000 })
      res.json({ ...result, serverId: server.id })
    } catch (error: unknown) {
      fail(res, error)
    } finally {
      if (server && acquired) pairingBusy.delete(server.id)
    }
  })
  api.post('/pair/complete', async (req, res) => {
    let server: ServerProfile | undefined
    let acquired = false
    try {
      server = requireServer(req.body.serverId)
      if (server.deviceToken) {
        await save(config)
        res.json({ status: 'complete', deviceId: server.deviceId, serverId: server.id })
        return
      }
      if (pairingBusy.has(server.id)) throw Error('正在配对，请稍后再试')
      const pending = pairingRequests.get(server.id)
      if (
        !pending ||
        pending.expiresAt < Date.now() ||
        pending.result.id !== req.body.id ||
        pending.result.privateSecret !== req.body.privateSecret
      )
        throw Error('配对申请已失效，请重新生成配对码')
      pairingBusy.add(server.id)
      acquired = true
      const result = await postGateway<{ status: string; deviceId?: string; token?: string }>(
        server.gateway,
        '/api/device/pairing/complete',
        { id: req.body.id, privateSecret: req.body.privateSecret },
      )
      if (result.status === 'complete') {
        if (!result.deviceId || !result.token) throw Error('服务器配对响应无效')
        server.deviceId = result.deviceId
        server.deviceToken = result.token
        pairingRequests.delete(server.id)
        await save(config)
        if (config.activeServerId === server.id) connect()
        publishConfig()
      }
      res.json({ status: result.status, deviceId: result.deviceId, serverId: server.id })
    } catch (error: unknown) {
      fail(res, error)
    } finally {
      if (server && acquired) pairingBusy.delete(server.id)
    }
  })
  /** 主动解除绑定时同步撤销服务端设备，暂停、切换均不走此入口。 */
  api.post('/unpair', async (req, res) => {
    try {
      if (req.body.localOnly !== undefined && typeof req.body.localOnly !== 'boolean')
        throw Error('本地清除选项无效')
      // 仅本地清除必须由用户明确选择，仍要求有效的本地管理凭据。
      await revokeBinding(requireServer(req.body.serverId), req.body.localOnly === true)
      await save(config)
      publishConfig()
      res.json(status())
    } catch (error: unknown) {
      fail(res, error)
    }
  })
}
