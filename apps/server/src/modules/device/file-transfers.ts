import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Transform, Writable, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Request, Response } from 'express'
import {
  FILE_BINARY_LIMIT_BYTES,
  FILE_PREVIEW_LIMIT_BYTES,
  RPC_APPROVAL_TIMEOUT_MS,
  ToolOutputs,
} from '@rcm/protocol'
import { DeviceRpcError } from './device-rpc-pending'

/** 客户端归属和工作区 RPC 闭包只在短期传输的内存记录中有效。 */
interface Ticket {
  /** 创建地址时的账号与 OAuth 客户端。 */
  userId: string
  clientId: string
  /** 客户端使用的传输方向。 */
  method: 'GET' | 'PUT'
  /** 待上传文件的精确字节数，下载时省略。 */
  size?: number
  /** 设备控制消息执行原先授权的 File 操作，审批仍由 Runtime 决定。 */
  run: (transfer: { id: string; key: string }) => Promise<unknown>
  /** 尚未消费的地址过期时间，Unix 毫秒。 */
  expiresAt: number
}

/** Server 根据两端消费速度中继字节，并独立校验已传输的大小和摘要。 */
interface Bridge {
  /** 仅由已认证设备的控制消息交付。 */
  key: string
  /** 传输最多允许的原始字节数。 */
  limit: number
  /** 客户端上传来源，或下载与预览目的地。 */
  fromClient?: Readable
  toClient?: Writable
  /** 设备只能连接一次；中断立即停止管道。 */
  claimed: boolean
  controller: AbortController
  signal: AbortSignal
  receipt?: { size: number; sha256: string }
}

/** 待领取地址有效两分钟；每个活跃传输最多使用一次设备 RPC 等待预算。 */
const TICKET_TTL_MS = 2 * 60_000
const OCTET_STREAM = 'application/octet-stream'

/** 管理一次性文件地址、设备凭证及受限流式中继，文件正文不落到 Server 磁盘。 */
export class FileTransfers {
  private readonly tickets = new Map<string, Ticket>()
  private readonly bridges = new Map<string, Bridge>()

  /** Server 关闭时撤回待领取地址并中止本机仍在进行的文件流。 */
  close() {
    this.tickets.clear()
    for (const bridge of this.bridges.values()) bridge.controller.abort()
  }

  /** 创建一次性公开地址；调用方负责先检查工作区归属和操作权限。 */
  prepare(input: Omit<Ticket, 'expiresAt'>, publicUrl: string) {
    const now = Date.now()
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(id)
    }
    if (this.tickets.size >= 256) throw new DeviceRpcError('FILE_TRANSFER_BUSY')
    const id = randomUUID()
    const expiresAt = now + TICKET_TTL_MS
    this.tickets.set(id, { ...input, expiresAt })
    return { url: new URL('/mcp/files/' + id, publicUrl).href, method: input.method, expiresAt }
  }

  /** 同一账号和客户端可按指定方法领取一次地址，字节通过 HTTP 请求或响应传输。 */
  async client(id: string, userId: string, clientId: string, req: Request, res: Response) {
    res.set('Cache-Control', 'no-store')
    const ticket = this.tickets.get(id)
    if (
      !ticket ||
      ticket.expiresAt <= Date.now() ||
      ticket.userId !== userId ||
      ticket.clientId !== clientId
    ) {
      res.status(404).json({ error: 'FILE_TRANSFER_NOT_FOUND' })
      return
    }
    if (req.method !== ticket.method) {
      res.set('Allow', ticket.method).status(405).end()
      return
    }
    const uploading = ticket.method === 'PUT'
    if (uploading) {
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== OCTET_STREAM) {
        res.status(415).json({ error: 'FILE_CONTENT_TYPE_REQUIRED' })
        return
      }
      const length = req.headers['content-length']
      if (length !== undefined && Number(length) !== ticket.size) {
        res.status(400).json({ error: 'FILE_SIZE_MISMATCH' })
        return
      }
    } else {
      res.set({ 'Content-Type': OCTET_STREAM, 'Content-Disposition': 'attachment' })
      if (req.httpVersion === '1.1') res.set('Trailer', 'X-Content-SHA256')
    }
    this.tickets.delete(id)
    const controller = new AbortController()
    res.once('close', () => controller.abort())
    try {
      const { data, receipt } = await this.relay(
        id,
        ticket.run,
        controller,
        uploading
          ? { fromClient: req, limit: ticket.size! }
          : { toClient: res, limit: FILE_BINARY_LIMIT_BYTES },
      )
      if (uploading) {
        const result = ToolOutputs['file.write'].parse(data)
        if (result.sha256 !== receipt.sha256 || receipt.size !== ticket.size)
          throw new DeviceRpcError('INVALID_TOOL_RESULT')
        res.json(result)
      } else {
        const result = ToolOutputs['file.read'].parse(data)
        if (
          result.encoding !== 'stream' ||
          result.content !== undefined ||
          result.size !== receipt.size ||
          result.sha256 !== receipt.sha256
        )
          throw new DeviceRpcError('INVALID_TOOL_RESULT')
        if (receipt.size === 0) {
          res.removeHeader('Trailer')
          res.set('X-Content-SHA256', receipt.sha256)
        } else if (req.httpVersion === '1.1') {
          res.addTrailers({ 'X-Content-SHA256': receipt.sha256 })
        }
        res.end()
      }
    } catch (error) {
      if (res.destroyed) return
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.removeHeader('Trailer')
      res.removeHeader('Content-Disposition')
      res.removeHeader('Content-Type')
      const code = error instanceof DeviceRpcError ? error.message : 'FILE_TRANSFER_FAILED'
      const statuses: Record<string, number> = {
        FILE_TRANSFER_BUSY: 503,
        FILE_TOO_LARGE_OR_UNSUPPORTED: 413,
        FILE_SIZE_MISMATCH: 400,
        FILE_CONFLICT: 409,
        PERMISSION_DENIED: 403,
        POLICY_DENIED: 403,
        APPROVAL_DENIED: 403,
        WORKSPACE_NOT_FOUND: 404,
      }
      res.status(statuses[code] ?? 502).json({ error: code })
    }
  }

  /** 小图片使用同一条设备流，只有 MCP 返回边界需要把预览字节编码为 Base64。 */
  async preview(run: Ticket['run'], signal?: AbortSignal) {
    const controller = new AbortController()
    const cancel = () => controller.abort()
    if (signal?.aborted) cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    const chunks: Buffer[] = []
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk)
        done()
      },
    })
    try {
      const { data, receipt } = await this.relay(randomUUID(), run, controller, {
        toClient: sink,
        limit: FILE_PREVIEW_LIMIT_BYTES,
      })
      const metadata = ToolOutputs['file.read'].parse(data)
      if (
        metadata.encoding !== 'preview' ||
        metadata.content !== undefined ||
        metadata.size !== receipt.size ||
        metadata.sha256 !== receipt.sha256
      )
        throw new DeviceRpcError('INVALID_TOOL_RESULT')
      if (!metadata.mimeType.startsWith('image/')) throw new DeviceRpcError('UNSUPPORTED_FILE_TYPE')
      return { metadata, bytes: Buffer.concat(chunks, receipt.size) }
    } finally {
      sink.destroy()
      signal?.removeEventListener('abort', cancel)
    }
  }

  /** 仅设备控制消息携带的单次凭证可连接这条 HTTP 流。 */
  async device(id: string, req: Request, res: Response) {
    const bridge = this.bridges.get(id)
    if (
      !bridge ||
      bridge.claimed ||
      req.headers.authorization !== 'Bearer ' + bridge.key ||
      req.method !== (bridge.fromClient ? 'GET' : 'PUT')
    ) {
      res.status(404).end()
      return
    }
    bridge.claimed = true
    res.once('close', () => {
      if (!res.writableFinished) bridge.controller.abort()
    })
    const hash = createHash('sha256')
    let size = 0
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length
        if (size > bridge.limit) {
          done(new DeviceRpcError('FILE_SIZE_MISMATCH'))
          return
        }
        hash.update(chunk)
        done(null, chunk)
      },
    })
    try {
      if (bridge.fromClient) {
        res.set({ 'Content-Type': OCTET_STREAM, 'Cache-Control': 'no-store' })
        await pipeline(bridge.fromClient, limit, res, { signal: bridge.signal })
      } else {
        await pipeline(req, limit, bridge.toClient!, { signal: bridge.signal, end: false })
      }
      bridge.receipt = { size, sha256: hash.digest('hex') }
      if (!bridge.fromClient) res.status(204).end()
    } catch (error) {
      bridge.controller.abort(error)
      if (!res.destroyed) res.destroy()
    }
  }

  /** 注册流后再下发设备请求，确保设备获准开始时能够连接；中断或结束立即清理。 */
  private async relay(
    id: string,
    run: Ticket['run'],
    controller: AbortController,
    endpoints: Pick<Bridge, 'limit' | 'fromClient' | 'toClient'>,
  ) {
    if (this.bridges.size >= 32) throw new DeviceRpcError('FILE_TRANSFER_BUSY')
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(RPC_APPROVAL_TIMEOUT_MS),
    ])
    const key = randomBytes(32).toString('hex')
    const bridge: Bridge = { ...endpoints, key, claimed: false, controller, signal }
    if (signal.aborted) throw new DeviceRpcError('FILE_TRANSFER_FAILED')
    const interrupted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          reject(
            signal.reason instanceof DeviceRpcError
              ? signal.reason
              : new DeviceRpcError('FILE_TRANSFER_FAILED'),
          )
        },
        { once: true },
      )
    })
    this.bridges.set(id, bridge)
    try {
      const data = await Promise.race([run({ id, key }), interrupted])
      if (!bridge.receipt) throw new DeviceRpcError('FILE_TRANSFER_FAILED')
      return { data, receipt: bridge.receipt }
    } finally {
      this.bridges.delete(id)
      controller.abort()
    }
  }
}
