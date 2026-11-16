import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { McpController } from '../src/modules/mcp/mcp.controller'

const connect = jest.fn().mockResolvedValue(undefined)
const closeServer = jest.fn().mockResolvedValue(undefined)
const closeTransport = jest.fn().mockResolvedValue(undefined)
const handleRequest = jest.fn().mockResolvedValue(undefined)

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    connect,
    close: closeServer,
    registerTool: jest.fn(),
  })),
}))
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn().mockImplementation(() => ({
    handleRequest,
    close: closeTransport,
  })),
}))

/** 模拟真实 HTTP 响应事件，覆盖 MCP 请求级传输资源释放。 */
function response() {
  const emitter = new EventEmitter() as EventEmitter & {
    status: jest.Mock
    json: jest.Mock
    set: jest.Mock
    headersSent: boolean
    writableEnded: boolean
    destroyed: boolean
  }
  emitter.status = jest.fn().mockReturnValue(emitter)
  emitter.json = jest.fn().mockReturnValue(emitter)
  emitter.set = jest.fn().mockReturnValue(emitter)
  emitter.headersSent = false
  emitter.writableEnded = false
  emitter.destroyed = false
  return emitter
}

describe('MCP HTTP 生命周期', () => {
  beforeEach(() => jest.clearAllMocks())

  test('缺少 Bearer 凭据拒绝请求，不创建 MCP Transport', async () => {
    const oauth = { token: jest.fn() }
    const controller = new McpController(oauth as never, {} as never, {} as never)
    const res = response()
    await controller.post({ headers: {} } as Request, res as unknown as Response)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(connect).not.toHaveBeenCalled()
  })

  test('正常完成与客户端断连只释放一次资源', async () => {
    const oauth = { token: jest.fn().mockResolvedValue({ id: 'u', clientId: 'c' }) }
    const controller = new McpController(oauth as never, {} as never, {} as never)
    const res = response()
    await controller.post(
      { headers: { authorization: 'Bearer valid' }, body: {} } as unknown as Request,
      res as unknown as Response,
    )
    res.writableEnded = true
    res.emit('finish')
    res.emit('close')
    expect(closeTransport).toHaveBeenCalledTimes(1)
    expect(closeServer).toHaveBeenCalledTimes(1)
  })

  test('处理异常时返回 JSON-RPC 错误并释放连接', async () => {
    const oauth = { token: jest.fn().mockResolvedValue({ id: 'u', clientId: 'c' }) }
    handleRequest.mockRejectedValueOnce(new Error('broken'))
    const controller = new McpController(oauth as never, {} as never, {} as never)
    const res = response()
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await controller.post(
        { headers: { authorization: 'Bearer valid' }, body: {} } as unknown as Request,
        res as unknown as Response,
      )
      expect(res.status).toHaveBeenCalledWith(500)
      res.emit('close')
      expect(closeTransport).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})
