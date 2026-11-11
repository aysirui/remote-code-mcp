import express from 'express'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  save,
  activeServer,
  addServer,
  selectServer,
  authorizeWorkspace,
  workspaceViews,
  type Config,
  type ServerProfile,
} from './state'
import { postGateway } from './gateway-client'
import type { WriteApprovalQueue } from './write-approvals'
import type { LocalEvents, LocalEventName } from './local-events'
import { validateLocalCommand } from './command-operations'

/** 本地管理 HTTP Server 的外部依赖，由 Runtime 主入口注入以避免全局状态耦合。 */
export interface LocalServerOptions {
  port: number
  localKey: string
  config: Config
  approvals: WriteApprovalQueue
  events: LocalEvents
  status: () => object
  disconnect: () => void
  connect: () => void
  sync: () => Promise<void>
}

/**
 * 启动仅监听 127.0.0.1 的本地管理服务。
 * 所有 /local/api 请求必须带启动时生成的 Bearer Token，
 * 并强制 Host / Origin 校验，避免 DNS Rebinding 与跨站滥用。
 */
export function startLocalServer(options: LocalServerOptions) {
  const { port, localKey, config, approvals, events, status, disconnect, connect, sync } = options
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  /** 同源检查必须优先于 API 路由处理；Token 不得被转发至外部域名。 */
  app.use((req, res, next) => {
    if (req.get('host') !== `127.0.0.1:${port}`) {
      res.status(403).json({ error: 'invalid host' })
      return
    }
    const origin = req.get('origin')
    if (origin && origin !== `http://127.0.0.1:${port}`) {
      res.status(403).json({ error: 'origin denied' })
      return
    }
    if (req.path.startsWith('/local/api/') && req.headers.authorization !== 'Bearer ' + localKey) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  /**
   * 本地状态 SSE 订阅：复用 Bearer 鉴权，不把启动 Token 放在 URL 查询参数。
   * 首次连接发送完整快照，后续仅推送变化的资源；断连时移除监听器。
   */
  app.get('/local/api/events', (req, res) => {
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const send = (name: LocalEventName) => {
      if (res.destroyed || res.writableEnded) return
      const payload =
        name === 'status'
          ? status()
          : name === 'workspaces'
            ? workspaceViews(config)
            : approvals.list()
      res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
    }

    send('status')
    send('workspaces')
    send('write-approvals')

    const unsubscribe = events.subscribe(send)
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n')
    }, 25000)
    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  /** 当前设备连接状态，不包含原始设备凭据。 */
  app.get('/local/api/status', (_req, res) => res.json(status()))

  /** 获取本地用户尚未批准的文件写入任务。 */
  app.get('/local/api/write-approvals', (_req, res) => res.json(approvals.list()))

  /** 只接受布尔决定，每个审批请求只允许完成一次。 */
  app.post('/local/api/write-approvals/:id', (req, res) => {
    if (typeof req.body?.approve !== 'boolean') {
      res.status(400).json({ error: 'approve must be a boolean' })
      return
    }
    if (!approvals.answer(String(req.params.id), req.body.approve)) {
      res.status(404).json({ error: 'Approval expired or already handled' })
      return
    }
    res.json({ ok: true })
  })

  type Pairing = {
    id: string
    code: string
    privateSecret: string
    activationUrl: string
    expiresIn: number
  }
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
  const fail = (res: express.Response, error: unknown) =>
    res.status(400).json({ error: error instanceof Error ? error.message : '操作失败' })
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
  const revokeBinding = async (server: ServerProfile) => {
    if (pairingBusy.has(server.id)) throw Error('正在配对，请稍后再试')
    // 服务端确认撤销成功前保留本地凭据，离线时不会丢失恢复连接所需的信息。
    if (server.deviceToken)
      await postGateway(server.gateway, '/api/device/unpair', {}, server.deviceToken)
    if (config.activeServerId === server.id) disconnect()
    server.deviceId = undefined
    server.deviceToken = undefined
    pairingRequests.delete(server.id)
  }

  /** 兼容原入口：相同 origin 恢复原配置，不覆盖或清除任何已保存的配对。 */
  app.post('/local/api/config', async (req, res) => {
    try {
      const server = addServer(config, String(req.body.gateway), req.body.name)
      await switchServer(server.id)
      res.json(status())
    } catch (error: unknown) {
      fail(res, error)
    }
  })
  app.post('/local/api/servers', async (req, res) => {
    try {
      const server = addServer(config, String(req.body.gateway), String(req.body.name || ''))
      await save(config)
      publishConfig()
      res.json({ id: server.id })
    } catch (error: unknown) {
      fail(res, error)
    }
  })
  app.post('/local/api/servers/:id/activate', async (req, res) => {
    try {
      await switchServer(String(req.params.id))
      res.json(status())
    } catch (error: unknown) {
      fail(res, error)
    }
  })
  app.patch('/local/api/servers/:id', async (req, res) => {
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
  app.delete('/local/api/servers/:id', async (req, res) => {
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

  /** 配对始终绑定具体服务器；重复点击复用仍有效的配对码。 */
  app.post('/local/api/pair/start', async (req, res) => {
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
  app.post('/local/api/pair/complete', async (req, res) => {
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
  app.post('/local/api/unpair', async (req, res) => {
    try {
      await revokeBinding(requireServer(req.body.serverId))
      await save(config)
      publishConfig()
      res.json(status())
    } catch (error: unknown) {
      fail(res, error)
    }
  })

  /** 仅在本地展示目录供用户选择工作区，绝对路径不发送到 Gateway。 */
  app.get('/local/api/browse', async (req, res) => {
    try {
      const dir = await fs.realpath(String(req.query.path || os.homedir()))
      const entry = await fs.stat(dir)
      if (!entry.isDirectory()) throw Error('Folder required')
      const entries = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((x) => x.isDirectory() && !x.name.startsWith('.'))
        .slice(0, 250)
        .map((x) => ({ name: x.name, path: path.join(dir, x.name) }))
      res.json({ path: dir, parent: path.dirname(dir), entries })
    } catch (error: unknown) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Browse failed' })
    }
  })

  /** 本地目录共用，各服务器的访问权限独立展示。 */
  app.get('/local/api/workspaces', (_req, res) => res.json(workspaceViews(config)))
  app.post('/local/api/workspaces', async (req, res) => {
    try {
      const server = requireActiveServer(req.body.serverId)
      const root = await fs.realpath(String(req.body.root || ''))
      if (!(await fs.stat(root)).isDirectory()) throw Error('目录不存在')
      if ([os.homedir(), path.parse(root).root].includes(root))
        throw Error('不能授权整个用户目录或磁盘根目录')
      let workspace = config.workspaces.find((item) =>
        process.platform === 'win32'
          ? item.root.toLowerCase() === root.toLowerCase()
          : item.root === root,
      )
      if (!workspace) {
        workspace = {
          id: randomUUID(),
          name: String(req.body.name || path.basename(root)).slice(0, 128),
          root,
        }
        config.workspaces.push(workspace)
      }
      authorizeWorkspace(server, workspace.id)
      await save(config)
      await sync()
      events.publish('workspaces')
      events.publish('status')
      res.json({ id: workspace.id })
    } catch (error: unknown) {
      fail(res, error)
    }
  })
  app.patch('/local/api/workspaces/:id', async (req, res) => {
    try {
      const server = requireActiveServer(req.body.serverId)
      const workspace = config.workspaces.find((item) => item.id === req.params.id)
      if (!workspace) throw Error('工作区不存在')
      const policyUpdates = req.body.policies
      if (policyUpdates !== undefined) {
        if (!policyUpdates || typeof policyUpdates !== 'object' || Array.isArray(policyUpdates))
          throw Error('访问策略无效')
        for (const domain of ['file', 'git', 'command'] as const) {
          const value = policyUpdates[domain]
          if (
            value !== undefined &&
            (typeof value !== 'string' || !['deny', 'approval', 'allow'].includes(value))
          )
            throw Error(domain + ' 策略无效')
        }
      }
      if (req.body.authorized !== undefined && typeof req.body.authorized !== 'boolean')
        throw Error('授权状态无效')
      let grant = server.workspaces.find((item) => item.workspaceId === workspace.id)
      if (req.body.authorized === true) grant = authorizeWorkspace(server, workspace.id)
      if (!grant || (!grant.authorized && req.body.authorized !== false))
        throw Error('请先授权此服务器访问工作区')
      const next = {
        ...grant,
        permissions: { ...grant.permissions },
        policies: { ...grant.policies },
      }
      if (req.body.authorized === false) next.authorized = false
      if (typeof req.body.enabled === 'boolean') next.enabled = req.body.enabled
      if (typeof req.body.write === 'boolean') next.permissions.write = req.body.write
      if (policyUpdates) {
        for (const domain of ['file', 'git', 'command'] as const) {
          const value = policyUpdates[domain]
          if (value !== undefined) next.policies[domain] = value
        }
      }
      if (!next.authorized) next.policies = { file: 'deny', git: 'deny', command: 'deny' }
      server.workspaces[server.workspaces.indexOf(grant)] = next
      approvals.rejectWorkspace(grant.id)
      await save(config)
      await sync()
      publishConfig()
      res.json({ ok: true })
    } catch (error: unknown) {
      fail(res, error)
    }
  })
  const rejectWorkspaceApprovals = (id: string) => {
    const grant = activeServer(config).workspaces.find((item) => item.workspaceId === id)
    if (grant) approvals.rejectWorkspace(grant.id)
  }

  /**
   * 用户只能从本机管理界面配置固定命令，不能通过远程 RPC 提交 executable 或 args。
   * 命令修改不改变云端授权元数据；待审批的旧命令请求必须失效。
   */
  app.post('/local/api/workspaces/:id/commands', async (req, res) => {
    try {
      const workspace = config.workspaces.find((w) => w.id === req.params.id)
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' })
      const command = validateLocalCommand(req.body)
      if ((workspace.commands || []).length >= 20) throw Error('TOO_MANY_COMMANDS')
      if ((workspace.commands || []).some((item) => item.id === command.id))
        throw Error('COMMAND_ALREADY_EXISTS')
      workspace.commands = [...(workspace.commands || []), command]
      await save(config)
      rejectWorkspaceApprovals(workspace.id)
      events.publish('workspaces')
      return res.json(command)
    } catch (error: unknown) {
      return res
        .status(400)
        .json({ error: error instanceof Error ? error.message : 'Invalid command' })
    }
  })

  /** 删除本地命令配置并取消所有待审批的工作区请求。 */
  app.delete('/local/api/workspaces/:id/commands/:commandId', async (req, res) => {
    try {
      const workspace = config.workspaces.find((w) => w.id === req.params.id)
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' })
      const current = workspace.commands || []
      if (!current.some((item) => item.id === req.params.commandId))
        return res.status(404).json({ error: 'Command not found' })
      workspace.commands = current.filter((item) => item.id !== req.params.commandId)
      await save(config)
      rejectWorkspaceApprovals(workspace.id)
      events.publish('workspaces')
      return res.json({ ok: true })
    } catch (error: unknown) {
      return res
        .status(400)
        .json({ error: error instanceof Error ? error.message : 'Delete failed' })
    }
  })

  /** 移除工作区授权并同步云端，同时立即拒绝该工作区的待审批操作。 */
  app.delete('/local/api/workspaces/:id', async (req, res) => {
    rejectWorkspaceApprovals(String(req.params.id))
    for (const server of config.servers)
      server.workspaces = server.workspaces.filter((grant) => grant.workspaceId !== req.params.id)
    config.workspaces = config.workspaces.filter((w) => w.id !== req.params.id)
    await save(config)
    await sync()
    events.publish('workspaces')
    res.json({ ok: true })
  })

  // 开发使用 src/，发布编译后使用 dist/server/；静态页面统一位于 dist/web/。
  const ui = path.resolve(__dirname, path.basename(__dirname) === 'src' ? '../dist/web' : '../web')
  app.use(express.static(ui))
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(ui, 'index.html')))

  return app.listen(port, '127.0.0.1', () => {
    console.log(`Local UI: http://127.0.0.1:${port}/#token=${localKey}`)
    console.log('This URL is private; do not share its token.')
  })
}
