import 'reflect-metadata'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedException } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { McpToolOutputs, RPC_MESSAGE_LIMIT_BYTES, type RpcRequest } from '@rcm/protocol'
import { WebSocket } from 'ws'
import { configureHttp } from '../src/http-bootstrap'
import { Store } from '../src/infrastructure/database/store'
import { DeviceHub } from '../src/modules/device/device-hub'
import { McpController } from '../src/modules/mcp/mcp.controller'
import { OAuthService } from '../src/modules/oauth/oauth.service'

test('凭一次性地址分块传输原始字节，上传和下载领取时复查签发授权', async () => {
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
  const tokenHash = 'test-token-hash'
  let revoked = false
  const tokenByHash = jest.fn(async (hash: string) => {
    if (hash !== tokenHash || revoked) throw new UnauthorizedException()
  })
  const app = await NestFactory.create(
    {
      module: class TestModule {},
      controllers: [McpController],
      providers: [
        { provide: Store, useValue: store },
        { provide: DeviceHub, useValue: hub },
        {
          provide: OAuthService,
          useValue: {
            token: async (clientId: string) => ({ id: device.userId, clientId, tokenHash }),
            tokenByHash,
          },
        },
      ],
    },
    { logger: false, bodyParser: false },
  )
  const client = new Client({ name: 'file-transfer-test', version: '1.0.0' })
  const publicUrl = process.env.PUBLIC_URL
  const attachmentOrigins = process.env.MCP_ATTACHMENT_ORIGINS
  let socket: WebSocket | undefined
  let restoreAttachmentFetch: (() => void) | undefined
  try {
    configureHttp(app)
    hub.attach(app.getHttpServer())
    await app.listen(0, '127.0.0.1')
    const base = await app.getUrl()
    process.env.PUBLIC_URL = base
    process.env.MCP_ATTACHMENT_ORIGINS = ''
    const mcpUrl = new URL('/mcp', base)
    const socketUrl = new URL('/agent/connect', base)
    socketUrl.protocol = 'ws:'
    const runtime = new WebSocket(socketUrl, {
      headers: { Authorization: 'Bearer test-device' },
      maxPayload: RPC_MESSAGE_LIMIT_BYTES,
    })
    socket = runtime
    await once(runtime, 'open')
    const path = 'fixture.png'
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
          path: string
          mediaPreview?: true
        }
        if (payload.path === 'missing.bin') {
          // 目标检查失败时，设备直接返回错误，字节流尚未开始。
          runtime.send(
            JSON.stringify({
              kind: 'response',
              id: request.id,
              success: false,
              error: { code: 'FILE_NOT_FOUND', message: 'FILE_NOT_FOUND' },
            }),
          )
          return
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
          data = { path: payload.path, written: true, sha256: hash.digest('hex') }
        } else {
          const image = payload.mediaPreview === true
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
    const uploadTicket = McpToolOutputs['file.write'].parse(write.structuredContent)
    const uploadUrl = String(uploadTicket.url)
    expect(write.structuredContent).toMatchObject({ method: 'PUT', path })
    expect(Number(uploadTicket.expiresAt) - Date.now()).toBeGreaterThan(2 * 60_000)
    const wrongMethod = await fetch(uploadUrl, { method: 'POST', headers })
    expect(wrongMethod.status).toBe(404)
    await wrongMethod.body?.cancel()
    const downloadFromUpload = await fetch(uploadUrl)
    expect(downloadFromUpload.status).toBe(405)
    expect(downloadFromUpload.headers.get('allow')).toBe('PUT')
    const wrongLength = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.from([1]),
    })
    expect(wrongLength.status).toBe(400)
    await wrongLength.body?.cancel()
    const upload: RequestInit & { duplex: 'half' } = {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: Readable.from(chunks(deviceFirstChunk)) as unknown as RequestInit['body'],
      duplex: 'half',
    }
    const written = await fetch(uploadUrl, upload)
    expect(written.status).toBe(200)
    expect(await written.json()).toEqual({ path, written: true, sha256 })
    expect(tokenByHash).toHaveBeenCalledTimes(1)
    const repeatedUpload = await fetch(uploadUrl, { method: 'PUT' })
    expect(repeatedUpload.status).toBe(404)
    await repeatedUpload.body?.cancel()

    const revokedWrite = await client.callTool({
      name: 'file_write',
      arguments: { ...args, size: 1 },
    })
    revoked = true
    const revokedUpload = await fetch(
      String(McpToolOutputs['file.write'].parse(revokedWrite.structuredContent).url),
      { method: 'PUT', body: Buffer.from([1]) },
    )
    expect(revokedUpload.status).toBe(401)
    expect(await revokedUpload.json()).toEqual({ error: 'FILE_UPLOAD_AUTHORIZATION_EXPIRED' })
    expect(controlSizes).toHaveLength(1)
    revoked = false

    const read = await client.callTool({ name: 'file_read', arguments: args })
    expect(read.structuredContent).toMatchObject({ method: 'GET', encoding: 'stream' })
    const downloadUrl = String(McpToolOutputs['file.read'].parse(read.structuredContent).url)
    expect((await fetch(downloadUrl, { method: 'HEAD' })).status).toBe(405)
    const [first, second] = await Promise.all([fetch(downloadUrl), fetch(downloadUrl)])
    const download = first.ok ? first : second
    const duplicate = first.ok ? second : first
    expect(download.status).toBe(200)
    expect(duplicate.status).toBe(404)
    await duplicate.body?.cancel()
    expect(download.headers.get('content-type')).toContain('application/octet-stream')
    expect(download.headers.get('cache-control')).toBe('no-store')
    expect(tokenByHash).toHaveBeenCalledTimes(3)
    expect(tokenByHash).toHaveBeenLastCalledWith(tokenHash)
    const downloaded = createHash('sha256')
    for await (const chunk of Readable.fromWeb(
      download.body! as import('node:stream/web').ReadableStream<Uint8Array>,
    )) {
      clientSawDownload()
      downloaded.update(chunk)
    }
    expect(downloaded.digest('hex')).toBe(sha256)
    const replay = await fetch(downloadUrl)
    expect(replay.status).toBe(404)
    await replay.body?.cancel()

    const revokedRead = await client.callTool({ name: 'file_read', arguments: args })
    const revokedUrl = String(McpToolOutputs['file.read'].parse(revokedRead.structuredContent).url)
    revoked = true
    const rejected = await fetch(revokedUrl)
    expect(rejected.status).toBe(401)
    expect(await rejected.json()).toEqual({ error: 'FILE_DOWNLOAD_AUTHORIZATION_EXPIRED' })
    expect(tokenByHash).toHaveBeenCalledTimes(4)
    expect(controlSizes).toHaveLength(2)

    const card = await client.callTool({
      name: 'file_preview',
      arguments: { workspaceId: workspace.id, path: 'assets/pixel.png' },
    })
    expect(card).toMatchObject({
      structuredContent: {
        name: 'pixel.png',
        mimeType: 'image/png',
        size: preview.length,
        sha256: createHash('sha256').update(preview).digest('hex'),
      },
      _meta: { 'rcm/previewMedia': preview.toString('base64') },
    })
    expect(card.structuredContent).not.toHaveProperty('content')
    expect(card.content).not.toContainEqual(expect.objectContaining({ type: 'image' }))
    expect(controlSizes).toHaveLength(3)
    expect(Math.max(...controlSizes)).toBeLessThan(1024)
    expect(store.logOperation).toHaveBeenCalledTimes(3)

    // 宿主文件引用替身没有 Content-Length，MCP 调用完成时应已精确写入字节。
    const attachmentUrl = 'https://files.example.net/file-fixture?signature=test'
    const finalAttachmentUrl = 'https://assets.example.org/file-fixture?signature=test'
    const downloadAttachment = jest.fn(async (url: string, _options: RequestInit | undefined) =>
      url === attachmentUrl
        ? Response.redirect(finalAttachmentUrl, 302)
        : new Response(Uint8Array.from(preview)),
    )
    const originalFetch = globalThis.fetch
    const mocked = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, options) =>
        String(input).startsWith('https://')
          ? downloadAttachment(String(input), options)
          : originalFetch(input, options),
      )
    restoreAttachmentFetch = () => mocked.mockRestore()
    const newPath = 'edited.png'
    const attachmentArgs = {
      workspaceId: workspace.id,
      path: newPath,
      encoding: 'attachment',
      file: { file_id: 'file-fixture', download_url: attachmentUrl, mime_type: 'image/png' },
    }
    const { tools } = await client.listTools()
    expect(tools.find((tool) => tool.name === 'file_write')).toMatchObject({
      _meta: { 'openai/fileParams': ['file'] },
    })
    const unconfigured = await client.callTool({ name: 'file_write', arguments: attachmentArgs })
    expect(unconfigured).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'FILE_ATTACHMENT_URL_DENIED' }],
    })
    process.env.MCP_ATTACHMENT_ORIGINS = 'https://files.example.net'
    const denied = await client.callTool({
      name: 'file_write',
      arguments: {
        ...attachmentArgs,
        file: { ...attachmentArgs.file, download_url: 'https://files.example.net.other.test/file' },
      },
    })
    expect(denied).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'FILE_ATTACHMENT_URL_DENIED' }],
    })
    expect(controlSizes).toHaveLength(3)
    expect(downloadAttachment).not.toHaveBeenCalled()
    const deniedRedirect = await client.callTool({ name: 'file_write', arguments: attachmentArgs })
    expect(deniedRedirect).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'FILE_ATTACHMENT_URL_DENIED' }],
    })
    expect(downloadAttachment).toHaveBeenCalledTimes(1)
    process.env.MCP_ATTACHMENT_ORIGINS = 'https://files.example.net,https://assets.example.org'
    const saved = await client.callTool({ name: 'file_write', arguments: attachmentArgs })
    expect(saved.structuredContent).toEqual({
      path: newPath,
      written: true,
      sha256: createHash('sha256').update(preview).digest('hex'),
    })
    expect(downloadAttachment).toHaveBeenCalledTimes(3)
    expect(downloadAttachment).toHaveBeenLastCalledWith(finalAttachmentUrl, {
      signal: expect.any(AbortSignal),
      redirect: 'manual',
    })
    expect(controlSizes).toHaveLength(5)
    expect(Math.max(...controlSizes)).toBeLessThan(1024)

    downloadAttachment.mockResolvedValueOnce(new Response(null, { status: 410 }))
    const expired = await client.callTool({ name: 'file_write', arguments: attachmentArgs })
    expect(expired).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'FILE_ATTACHMENT_DOWNLOAD_FAILED' }],
    })

    downloadAttachment.mockResolvedValueOnce(
      new Response('<html>Preview</html>', { headers: { 'Content-Type': 'text/html' } }),
    )
    const landingPage = await client.callTool({ name: 'file_write', arguments: attachmentArgs })
    expect(landingPage).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'FILE_ATTACHMENT_DOWNLOAD_FAILED' }],
    })

    revoked = false
    const missingArgs = { ...args, path: 'missing.bin' }
    const missingRead = await client.callTool({ name: 'file_read', arguments: missingArgs })
    const missingDownload = await fetch(
      String(McpToolOutputs['file.read'].parse(missingRead.structuredContent).url),
    )
    expect(missingDownload.status).toBe(404)
    expect(await missingDownload.json()).toEqual({ error: 'FILE_NOT_FOUND' })

    const missingWrite = await client.callTool({
      name: 'file_write',
      arguments: { ...missingArgs, expectedSha256: sha256, size: 1 },
    })
    const missingUpload = await fetch(
      String(McpToolOutputs['file.write'].parse(missingWrite.structuredContent).url),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from([1]),
      },
    )
    expect(missingUpload.status).toBe(404)
    expect(await missingUpload.json()).toEqual({ error: 'FILE_NOT_FOUND' })

    // 带 JSON Content-Type 的原文件也必须绕过请求体解析器，保留原有空格和换行。
    const jsonBytes = Buffer.from('{ "key": "value" }\r\n')
    const jsonWrite = await client.callTool({
      name: 'file_write',
      arguments: { ...args, path: 'fixture.json', size: jsonBytes.length },
    })
    const jsonUpload = await fetch(
      String(McpToolOutputs['file.write'].parse(jsonWrite.structuredContent).url),
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: jsonBytes },
    )
    expect(jsonUpload.status).toBe(200)
    expect(await jsonUpload.json()).toEqual({
      path: 'fixture.json',
      written: true,
      sha256: createHash('sha256').update(jsonBytes).digest('hex'),
    })
  } finally {
    restoreAttachmentFetch?.()
    if (publicUrl === undefined) delete process.env.PUBLIC_URL
    else process.env.PUBLIC_URL = publicUrl
    if (attachmentOrigins === undefined) delete process.env.MCP_ATTACHMENT_ORIGINS
    else process.env.MCP_ATTACHMENT_ORIGINS = attachmentOrigins
    await client.close()
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, 'close')
      socket.terminate()
      await closed
    }
    await app.close()
  }
}, 15_000)
