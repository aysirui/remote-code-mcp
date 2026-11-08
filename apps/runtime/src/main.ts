import express from 'express'
import { WebSocket } from 'ws'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { load, save, publicWs, type Config } from './state'
import { execute } from './executors'
import { RpcRequestSchema, ToolInputs, type RpcRequest } from '@rcm/protocol'
const port = Number(process.env.RUNTIME_PORT || 18787)
const localKey = randomBytes(32).toString('base64url')
let config: Config
let socket: WebSocket | undefined
let online = false
let stopped = false
let reconnectTimer: ReturnType<typeof setTimeout> | undefined

type WriteApproval = {
  id: string
  workspaceId: string
  workspaceName: string
  path: string
  bytes: number
  preview: string
  truncated: boolean
  createdAt: number
  resolve: (approved: boolean) => void
  timeout: ReturnType<typeof setTimeout>
}
const writeApprovals = new Map<string, WriteApproval>()

function cancelWriteApprovals() {
  for (const approval of writeApprovals.values()) {
    clearTimeout(approval.timeout)
    approval.resolve(false)
  }
  writeApprovals.clear()
}

function requestWriteApproval(req: RpcRequest, workspace: Config['workspaces'][number]) {
  if (writeApprovals.size >= 20) throw Error('TOO_MANY_PENDING_WRITE_APPROVALS')
  const payload = ToolInputs['file.write'].parse(req.payload)
  const id = randomUUID()
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      writeApprovals.delete(id)
      resolve(false)
    }, 30000)
    writeApprovals.set(id, {
      id,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      path: payload.path,
      bytes: Buffer.byteLength(payload.content, 'utf8'),
      preview: payload.content.slice(0, 2000),
      truncated: payload.content.length > 2000,
      createdAt: Date.now(),
      resolve,
      timeout,
    })
  })
}


function disconnect() {
  cancelWriteApprovals()
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = undefined
  const previous = socket
  socket = undefined
  online = false
  previous?.close()
}
const stat = () => ({
  online,
  paired: !!config.deviceToken,
  deviceId: config.deviceId,
  gateway: config.gateway,
  name: config.name,
  workspaces: config.workspaces.map(publicWs),
})
function connect() {
  if (stopped || !config.deviceToken || socket) return
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = undefined
  const wsURL = new URL(config.gateway)
  if (!['http:', 'https:'].includes(wsURL.protocol)) return
  // Never send the device Bearer token over an unencrypted remote connection.
  if (wsURL.protocol === 'http:' &&
      !['127.0.0.1', 'localhost'].includes(wsURL.hostname)) {
    console.error('HTTPS gateway required for remote devices')
    return
  }
  wsURL.protocol = wsURL.protocol === 'https:' ? 'wss:' : 'ws:'
  wsURL.pathname = '/agent/connect'
  const connection = new WebSocket(wsURL.toString(), {
    headers: { Authorization: 'Bearer ' + config.deviceToken },
  })
  socket = connection
  connection.on('open', () => {
    if (socket !== connection) return
    online = true
    connection.send(
      JSON.stringify({
        kind: 'hello',
        runtimeVersion: '0.1.0',
        workspaces: config.workspaces.map(publicWs),
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
      const workspace = config.workspaces.find((x) => x.id === parsed.workspaceId)
      if (!workspace) throw Error('WORKSPACE_NOT_FOUND')
      if (parsed.deadlineAt < Date.now()) throw Error('REQUEST_EXPIRED')
      if (parsed.operation === 'file.write') {
        const approved = await requestWriteApproval(parsed, workspace)
        if (!approved) throw Error('WRITE_APPROVAL_DENIED_OR_EXPIRED')
        if (socket !== connection) throw Error('CONNECTION_REPLACED')
        if (parsed.deadlineAt < Date.now()) throw Error('REQUEST_EXPIRED')
        // The local grant may have been removed or disabled during approval.
        const currentWorkspace = config.workspaces.find((w) => w.id === parsed.workspaceId)
        if (currentWorkspace !== workspace || !workspace.enabled ||
            !workspace.permissions.read || !workspace.permissions.write)
          throw Error('WORKSPACE_PERMISSION_REVOKED')
      }
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
  connection.on('close', () => {
    if (socket !== connection) return
    online = false
    socket = undefined
    if (!stopped && config.deviceToken)
      reconnectTimer = setTimeout(connect, 3500)
  })
  connection.on('error', (e) => console.error('Gateway WebSocket', e.message))
}
async function sync() {
  if (online && socket?.readyState === WebSocket.OPEN)
    socket.send(
      JSON.stringify({
        kind: 'hello',
        runtimeVersion: '0.1.0',
        workspaces: config.workspaces.map(publicWs),
      }),
    )
}
async function api(relative: string, body: any) {
  const gateway = new URL(config.gateway)
  if (gateway.protocol !== 'https:' &&
      !(gateway.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(gateway.hostname)))
    throw Error('HTTPS gateway required')
  const url = new URL(relative, gateway)
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const v = await r.json()
  if (!r.ok) throw Error((v as any).message || r.statusText)
  return v as any
}
async function boot() {
  config = await load()
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))
  app.use((req, res, next) => {
    // Only serve the loopback interface and its explicit HTTP authority.
    // Reject DNS rebinding, localhost aliases and hostile Host headers.
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
  app.get('/local/api/status', (_req, res) => res.json(stat()))
  app.get('/local/api/write-approvals', (_req, res) => {
    res.json([...writeApprovals.values()].map(({ id, workspaceId, workspaceName, path, bytes, preview, truncated, createdAt }) => ({
      id, workspaceId, workspaceName, path, bytes, preview, truncated, createdAt,
    })))
  })
  app.post('/local/api/write-approvals/:id', (req, res) => {
    const approval = writeApprovals.get(req.params.id)
    if (!approval) {
      res.status(404).json({ error: 'Approval expired or already handled' })
      return
    }
    if (typeof req.body?.approve !== 'boolean') {
      res.status(400).json({ error: 'approve must be a boolean' })
      return
    }
    writeApprovals.delete(approval.id)
    clearTimeout(approval.timeout)
    approval.resolve(req.body.approve)
    res.json({ ok: true })
  })

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
      res.json(stat())
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })
  app.post('/local/api/pair/start', async (_req, res) => {
    try {
      const r = await api('/api/device/pairing/start', {
        name: config.name,
        platform: process.platform,
      })
      res.json(r)
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })
  app.post('/local/api/pair/complete', async (req, res) => {
    try {
      const r = await api('/api/device/pairing/complete', req.body)
      if (r.status === 'complete') {
        config.deviceId = r.deviceId
        config.deviceToken = r.token
        await save(config)
        connect()
      }
      res.json({ status: r.status, deviceId: r.deviceId })
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })
  app.post('/local/api/unpair', async (_req, res) => {
    disconnect()
    config.deviceId = undefined
    config.deviceToken = undefined
    await save(config)
    res.json(stat())
  })
  app.get('/local/api/browse', async (req, res) => {
    try {
      const dir = await fs.realpath(String(req.query.path || os.homedir()))
      const stat = await fs.stat(dir)
      if (!stat.isDirectory()) throw Error('Folder required')
      const entries = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((x) => x.isDirectory() && !x.name.startsWith('.'))
        .slice(0, 250)
        .map((x) => ({ name: x.name, path: path.join(dir, x.name) }))
      res.json({ path: dir, parent: path.dirname(dir), entries })
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })
  app.get('/local/api/workspaces', (_req, res) =>
    res.json(config.workspaces.map((w) => ({ ...publicWs(w), root: w.root }))),
  )
  app.post('/local/api/workspaces', async (req, res) => {
    try {
      const root = await fs.realpath(String(req.body.root || ''))
      if (!(await fs.stat(root)).isDirectory()) throw Error('Folder required')
      if ([os.homedir(), path.parse(root).root].includes(root))
        throw Error('Do not authorize home or filesystem root')
      const name = String(req.body.name || path.basename(root)).slice(0, 128)
      const w = {
        id: randomUUID(),
        name,
        root,
        enabled: true,
        permissions: { read: true, write: false },
      }
      config.workspaces.push(w)
      await save(config)
      await sync()
      res.json(w)
    } catch (e: any) {
      res.status(400).json({ error: e.message })
    }
  })
  app.patch('/local/api/workspaces/:id', async (req, res) => {
    const w = config.workspaces.find((x) => x.id === req.params.id)
    if (!w) {
      res.status(404).end()
      return
    }
    if (typeof req.body.enabled === 'boolean') w.enabled = req.body.enabled
    if (typeof req.body.write === 'boolean') w.permissions.write = req.body.write
    await save(config)
    await sync()
    res.json(w)
  })
  app.delete('/local/api/workspaces/:id', async (req, res) => {
    for (const approval of writeApprovals.values()) {
      if (approval.workspaceId !== req.params.id) continue
      writeApprovals.delete(approval.id)
      clearTimeout(approval.timeout)
      approval.resolve(false)
    }
    config.workspaces = config.workspaces.filter((w) => w.id !== req.params.id)
    await save(config)
    await sync()
    res.json({ ok: true })
  })
  // tsx runs from src/; compiled Node.js runs from dist/server/.
  const ui = path.resolve(
    __dirname,
    path.basename(__dirname) === 'src' ? '../dist/web' : '../web',
  )
  app.use(express.static(ui))
  app.get('/{*splat}', async (_req, res) => {
    res.sendFile(path.join(ui, 'index.html'))
  })
  const httpServer = app.listen(port, '127.0.0.1', () => {
    console.log(`Local UI: http://127.0.0.1:${port}/#token=${localKey}`)
    console.log('This URL is private; do not share its token.')
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
