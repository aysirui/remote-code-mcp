import 'reflect-metadata'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { NestFactory } from '@nestjs/core'
import { McpToolOutputs, RPC_MESSAGE_LIMIT_BYTES, type RpcRequest } from '@rcm/protocol'
import { WebSocket } from 'ws'
import { configureHttp } from '../src/http-bootstrap'
import { Store } from '../src/infrastructure/database/store'
import { DeviceHub } from '../src/modules/device/device-hub'
import { McpController } from '../src/modules/mcp/mcp.controller'
import { OAuthService } from '../src/modules/oauth/oauth.service'

test('MCP 授权地址双向转发字节流，设备 RPC 只携带控制信息', async () => {
  const workspace = { id: randomUUID(), deviceId: 'device', localRead: true, localWrite: true }
  const device = { id: workspace.deviceId, userId: 'owner', status: 'active' }
  const query = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn(),
  }
  let accessQuery = 0
  const store = {
    db: { select: () => query },
    one: jest
      .fn(async (): Promise<unknown> => (accessQuery++ % 2 ? device : workspace))
      .mockResolvedValueOnce({ deviceId: device.id, revokedAt: null })
      .mockResolvedValueOnce(device)
      .mockResolvedValueOnce({ status: 'active' }),
    logOperation: jest.fn().mockResolvedValue(undefined),
  }
  const hub = new DeviceHub(store as unknown as Store)
  const app = await NestFactory.create(
    {
      module: class TestModule {},
      controllers: [McpController],
      providers: [
        { provide: Store, useValue: store },
        { provide: DeviceHub, useValue: hub },
        {
          provide: OAuthService,
          useValue: { token: async (clientId: string) => ({ id: device.userId, clientId }) },
        },
      ],
    },
    { logger: false, bodyParser: false },
  )
  const client = new Client({ name: 'file-transfer-test', version: '1.0.0' })
  const publicUrl = process.env.PUBLIC_URL
  let socket: WebSocket | undefined
  try {
    configureHttp(app)
    hub.attach(app.getHttpServer())
    await app.listen(0, '127.0.0.1')
    const base = await app.getUrl()
    process.env.PUBLIC_URL = base
    const mcpUrl = new URL('/mcp', base)
    const socketUrl = new URL('/agent/connect', base)
    socketUrl.protocol = 'ws:'
    const runtime = new WebSocket(socketUrl, {
      headers: { Authorization: 'Bearer test-device' },
      maxPayload: RPC_MESSAGE_LIMIT_BYTES,
    })
    socket = runtime
    await once(runtime, 'open')
    const path = 'fixture.bin'
    const size = 6 * 1024 * 1024
    const block = Buffer.alloc(64 * 1024, 0xa5)
    let deviceSawUpload!: () => void
    let clientSawDownload!: () => void
    const deviceFirstChunk = new Promise<void>((resolve) => {
      deviceSawUpload = resolve
    })
    const clientFirstChunk = new Promise<void>((resolve) => {
      clientSawDownload = resolve
    })
    /** 客户端上传和设备下载均多次产生原始块，超过原有单个 JSON 消息限制。 */
    async function* chunks(consumed?: Promise<void>) {
      for (let offset = 0; offset < size; offset += block.length) {
        if (offset === block.length) await consumed
        yield block
      }
    }
    const hash = createHash('sha256')
    for await (const chunk of chunks()) hash.update(chunk)
    const sha256 = hash.digest('hex')
    const headers = { Authorization: 'Bearer test-client' }
    const controlSizes: number[] = []
    const preview = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAALSURBVBhXY2AAAgAABQABqtXIUQAAAABJRU5ErkJggg==',
      'base64',
    )
    runtime.on('message', (message) => {
      const request = JSON.parse(message.toString()) as RpcRequest
      controlSizes.push(message.toString().length)
      void (async () => {
        const payload = request.payload as {
          transfer: { id: string; key: string }
          encoding: string
        }
        const url = new URL('/mcp/files/' + payload.transfer.id + '/device', base)
        const auth = { Authorization: 'Bearer ' + payload.transfer.key }
        let data: unknown
        if (request.operation === 'file.write') {
          const incoming = await fetch(url, { headers: auth })
          expect(incoming.ok).toBe(true)
          const hash = createHash('sha256')
          for await (const chunk of Readable.fromWeb(
            incoming.body! as import('node:stream/web').ReadableStream<Uint8Array>,
          )) {
            deviceSawUpload()
            hash.update(chunk)
          }
          data = { path, written: true, sha256: hash.digest('hex') }
        } else {
          const image = payload.encoding === 'preview'
          const options: RequestInit & { duplex: 'half' } = {
            method: 'PUT',
            headers: auth,
            duplex: 'half',
            body: Readable.from(
              image ? [preview] : chunks(clientFirstChunk),
            ) as unknown as RequestInit['body'],
          }
          const response = await fetch(url, options)
          expect(response.status).toBe(204)
          data = {
            encoding: payload.encoding,
            mimeType: image ? 'image/png' : 'application/octet-stream',
            size: image ? preview.length : size,
            sha256: image ? createHash('sha256').update(preview).digest('hex') : sha256,
          }
        }
        runtime.send(JSON.stringify({ kind: 'response', id: request.id, success: true, data }))
      })().catch(() =>
        runtime.send(
          JSON.stringify({
            kind: 'response',
            id: request.id,
            success: false,
            error: { code: 'FILE_TRANSFER_FAILED', message: 'FILE_TRANSFER_FAILED' },
          }),
        ),
      )
    })
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers } }))
    const args = { workspaceId: workspace.id, path, encoding: 'stream' }
    const write = await client.callTool({ name: 'file_write', arguments: { ...args, size } })
    const uploadUrl = String(McpToolOutputs['file.write'].parse(write.structuredContent).url)
    expect(write.structuredContent).toMatchObject({ method: 'PUT', path })
    const wrongClient = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: 'Bearer other-client' },
    })
    expect(wrongClient.status).toBe(404)
    await wrongClient.body?.cancel()
    const wrongLength = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from([1]),
    })
    expect(wrongLength.status).toBe(400)
    await wrongLength.body?.cancel()
    const upload: RequestInit & { duplex: 'half' } = {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: Readable.from(chunks(deviceFirstChunk)) as unknown as RequestInit['body'],
      duplex: 'half',
    }
    const written = await fetch(uploadUrl, upload)
    expect(written.status).toBe(200)
    expect(await written.json()).toEqual({ path, written: true, sha256 })

    const read = await client.callTool({ name: 'file_read', arguments: args })
    expect(read.structuredContent).toMatchObject({ method: 'GET', encoding: 'stream' })
    const downloadUrl = String(McpToolOutputs['file.read'].parse(read.structuredContent).url)
    const download = await fetch(downloadUrl, { headers })
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toContain('application/octet-stream')
    const downloaded = createHash('sha256')
    for await (const chunk of Readable.fromWeb(
      download.body! as import('node:stream/web').ReadableStream<Uint8Array>,
    )) {
      clientSawDownload()
      downloaded.update(chunk)
    }
    expect(downloaded.digest('hex')).toBe(sha256)
    const replay = await fetch(downloadUrl, { headers })
    expect(replay.status).toBe(404)
    await replay.body?.cancel()

    const viewed = await client.callTool({
      name: 'file_read',
      arguments: { ...args, path: 'pixel.png', encoding: 'preview' },
    })
    expect(viewed.content).toContainEqual({
      type: 'image',
      mimeType: 'image/png',
      data: preview.toString('base64'),
    })
    expect(controlSizes).toHaveLength(3)
    expect(Math.max(...controlSizes)).toBeLessThan(1024)
    expect(store.logOperation).toHaveBeenCalledTimes(3)
  } finally {
    if (publicUrl === undefined) delete process.env.PUBLIC_URL
    else process.env.PUBLIC_URL = publicUrl
    await client.close()
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, 'close')
      socket.terminate()
      await closed
    }
    await app.close()
  }
}, 15_000)
