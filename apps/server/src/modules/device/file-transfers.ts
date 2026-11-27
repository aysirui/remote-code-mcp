import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Request, Response } from 'express'
import { UnauthorizedException } from '@nestjs/common'
import {
  FILE_BINARY_LIMIT_BYTES,
  FILE_INLINE_LIMIT_BYTES,
  RPC_APPROVAL_TIMEOUT_MS,
  ToolOutputs,
} from '@rcm/protocol'
import { DeviceRpcError } from './device-rpc-pending'

/** 传输方向决定领取授权；短期记录只存放在 Server 内存。 */
type TransferRequest = {
  /** 设备控制消息执行原先授权的 File 操作，审批仍由 Runtime 决定。 */
  run: (transfer: { id: string; key: string }) => Promise<unknown>
} & (
  | {
      method: 'GET'
      /** 复查签发下载地址时的 OAuth 授权。 */ authorizeDownload: () => Promise<void>
    }
  | {
      method: 'PUT'
      /** 创建上传地址时的账号与 OAuth 客户端。 */
      userId: string
      clientId: string
      /** 待上传文件的精确字节数。 */
      size: number
    }
)

type Ticket = TransferRequest & {
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

  /** 创建一次性传输地址；下载地址本身是凭据，调用方须先检查工作区归属和权限。 */
  prepare(input: TransferRequest, publicUrl: string) {
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

  /** 下载凭地址领取，上传凭账号和客户端领取；按指定 HTTP 方法流式传输原始字节。 */
  async client(id: string, req: Request, res: Response, user?: { id: string; clientId: string }) {
    res.set('Cache-Control', 'no-store')
    const ticket = this.tickets.get(id)
    if (
      !ticket ||
      ticket.expiresAt <= Date.now() ||
      (ticket.method === 'PUT' && (ticket.userId !== user?.id || ticket.clientId !== user.clientId))
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
    // 在异步复查前消费地址，确保并发请求最多只有一个能进入设备中继。
    this.tickets.delete(id)
    const controller = new AbortController()
    res.once('close', () => controller.abort())
    try {
      if (ticket.method === 'GET') await ticket.authorizeDownload()
      const { data, receipt } = await this.relay(
        id,
        ticket.run,
        controller,
        uploading
          ? { fromClient: req, limit: ticket.size }
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
      if (error instanceof UnauthorizedException) {
        res.status(401).json({ error: 'FILE_DOWNLOAD_AUTHORIZATION_EXPIRED' })
        return
      }
      const code = error instanceof DeviceRpcError ? error.message : 'FILE_TRANSFER_FAILED'
      const statuses: Record<string, number> = {
        FILE_TRANSFER_BUSY: 503,
        FILE_TOO_LARGE: 413,
        FILE_SIZE_MISMATCH: 400,
        FILE_CONFLICT: 409,
        PERMISSION_DENIED: 403,
        POLICY_DENIED: 403,
        APPROVAL_DENIED: 403,
        WORKSPACE_NOT_FOUND: 404,
        // 下载目标或必须存在的上传目标缺失。
        FILE_NOT_FOUND: 404,
      }
      res.status(statuses[code] ?? 502).json({ error: code })
    }
  }

  /**
   * 将已校验的附件源接入设备写入流。Runtime 通过审批并检查目标版本后才消费附件。
   * @param open 按取消信号按需读取上游附件，正文仅在流中转发。
   * @param run 下发绑定原工作区和目标路径的写入请求。
   * @param signal 当前 MCP 调用的取消信号。
   * @returns Runtime 已完成写入的结果。
   */
  async writeFromSource(
    open: (signal: AbortSignal) => AsyncIterable<Uint8Array>,
    run: Ticket['run'],
    signal: AbortSignal,
  ) {
    const controller = new AbortController()
    const cancel = () => controller.abort()
    if (signal.aborted) cancel()
    signal.addEventListener('abort', cancel, { once: true })
    const source = Readable.from(open(controller.signal), { objectMode: false })
    // 在管道关闭设备响应之前保留上游业务错误，避免笼统的断流错误覆盖附件失败原因。
    source.once('error', (error) => controller.abort(error))
    try {
      const { data, receipt } = await this.relay(randomUUID(), run, controller, {
        fromClient: source,
        limit: FILE_BINARY_LIMIT_BYTES,
      })
      const result = ToolOutputs['file.write'].parse(data)
      if (result.sha256 !== receipt.sha256) throw new DeviceRpcError('INVALID_TOOL_RESULT')
      return result
    } finally {
      source.destroy()
      signal.removeEventListener('abort', cancel)
    }
  }

  /** 通过设备流读取小文件，返回已核对的原始字节和元数据，调用方决定输出形式。 */
  async readInline(run: Ticket['run'], signal?: AbortSignal) {
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
        limit: FILE_INLINE_LIMIT_BYTES,
      })
      const metadata = ToolOutputs['file.read'].parse(data)
      if (
        metadata.encoding !== 'inline' ||
        metadata.content !== undefined ||
        metadata.size !== receipt.size ||
        metadata.sha256 !== receipt.sha256
      )
        throw new DeviceRpcError('INVALID_TOOL_RESULT')
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
          const code =
            bridge.limit === FILE_BINARY_LIMIT_BYTES ? 'FILE_TOO_LARGE' : 'FILE_SIZE_MISMATCH'
          done(new DeviceRpcError(code))
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
