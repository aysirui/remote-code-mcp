import express from 'express'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { publicWs, save, type Config } from './state'
import { postGateway } from './gateway-client'
import type { WriteApprovalQueue } from './write-approvals'

/** 本地管理 HTTP Server 的外部依赖，由 Runtime 主入口注入以避免全局状态耦合。 */
export interface LocalServerOptions {
  port: number
  localKey: string
  config: Config
  approvals: WriteApprovalQueue
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
  const { port, localKey, config, approvals, status, disconnect, connect, sync } = options
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

  /** 更换 Gateway 时清除旧设备配对凭据，禁止复用上一服务器的身份。 */
  app.post('/local/api/config', async (req, res) => {
    try {
      const u = new URL(String(req.body.gateway))
      if (
        !['https:', 'http:'].includes(u.protocol) ||
        (u.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(u.hostname))
      )
        throw Error('HTTPS gateway required')
      disconnect()
      config.gateway = u.origin
      config.deviceId = undefined
      config.deviceToken = undefined
      await save(config)
      res.json(status())
    } catch (error: unknown) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid gateway' })
    }
  })

  /** 仅向配置的 Gateway 请求配对码，不接受任意远程请求地址。 */
  app.post('/local/api/pair/start', async (_req, res) => {
    try {
      const result = await postGateway(config.gateway, '/api/device/pairing/start', {
        name: config.name,
        platform: process.platform,
      })
      res.json(result)
    } catch (error: unknown) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Pairing failed' })
    }
  })

  /** 领取一次性设备凭据，只持久化 Runtime 私有配置，响应不返回 Token。 */
  app.post('/local/api/pair/complete', async (req, res) => {
    try {
      const result = await postGateway<{ status: string; deviceId?: string; token?: string }>(
        config.gateway,
        '/api/device/pairing/complete',
        req.body,
      )
      if (result.status === 'complete') {
        if (!result.deviceId || !result.token) throw Error('Invalid pairing response')
        config.deviceId = result.deviceId
        config.deviceToken = result.token
        await save(config)
        connect()
      }
      res.json({ status: result.status, deviceId: result.deviceId })
    } catch (error: unknown) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Pairing failed' })
    }
  })

  /** 断开本地绑定；真正撤销云端凭据还需从 Console 解绑设备。 */
  app.post('/local/api/unpair', async (_req, res) => {
    disconnect()
    config.deviceId = undefined
    config.deviceToken = undefined
    await save(config)
    res.json(status())
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

  /** 工作区详情仅供本地管理页面使用，包含目录绝对路径。 */
  app.get('/local/api/workspaces', (_req, res) =>
    res.json(config.workspaces.map((w) => ({ ...publicWs(w), root: w.root }))),
  )

  /** 授权一个本地目录，默认只读；拒绝将家目录或文件系统根目录整体授权。 */
  app.post('/local/api/workspaces', async (req, res) => {
    try {
      const root = await fs.realpath(String(req.body.root || ''))
      if (!(await fs.stat(root)).isDirectory()) throw Error('Folder required')
      if ([os.homedir(), path.parse(root).root].includes(root))
        throw Error('Do not authorize home or filesystem root')
      const name = String(req.body.name || path.basename(root)).slice(0, 128)
      const workspace = {
        id: randomUUID(),
        name,
        root,
        enabled: true,
        permissions: { read: true, write: false },
      }
      config.workspaces.push(workspace)
      await save(config)
      await sync()
      res.json(workspace)
    } catch (error: unknown) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Workspace failed' })
    }
  })

  /** 修改本地授权；撤销写入/停用工作区时取消尚未完成的写入审批。 */
  app.patch('/local/api/workspaces/:id', async (req, res) => {
    const workspace = config.workspaces.find((w) => w.id === req.params.id)
    if (!workspace) {
      res.status(404).end()
      return
    }
    if (typeof req.body.enabled === 'boolean') workspace.enabled = req.body.enabled
    if (typeof req.body.write === 'boolean') workspace.permissions.write = req.body.write
    if (!workspace.enabled || !workspace.permissions.write) approvals.rejectWorkspace(workspace.id)
    await save(config)
    await sync()
    res.json(workspace)
  })

  /** 移除工作区授权并同步云端，同时立即拒绝该工作区的待审批操作。 */
  app.delete('/local/api/workspaces/:id', async (req, res) => {
    approvals.rejectWorkspace(String(req.params.id))
    config.workspaces = config.workspaces.filter((w) => w.id !== req.params.id)
    await save(config)
    await sync()
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
