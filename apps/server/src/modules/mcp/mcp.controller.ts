import { Controller, Get, Delete, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { env } from '../../config/env'
import { DeviceHub } from '../device/device-hub'
import { Store } from '../../infrastructure/database/store'
import { OAuthService } from '../oauth/oauth.service'
import { registerMcpTools } from './mcp-tools'

/** MCP Streamable HTTP 接口：由 NestJS 管理路由及依赖，原生传输协议保持不变。 */
@Controller('mcp')
export class McpController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly hub: DeviceHub,
    private readonly store: Store,
  ) {}

  /** 当前采用无会话 HTTP 传输，GET 与 DELETE 不支持。 */
  @Get()
  get(@Res() res: Response) {
    return res.status(405).end()
  }

  @Delete()
  delete(@Res() res: Response) {
    return res.status(405).end()
  }

  /** 每次已认证请求独立创建 MCP Server 和 Transport，避免跨客户端状态共享。 */
  @Post()
  async post(@Req() req: Request, @Res() res: Response) {
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : ''
    if (!bearer) {
      res.set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${env.publicUrl}/.well-known/oauth-protected-resource"`,
      )
      return res.status(401).json({ error: 'unauthorized' })
    }
    let user
    try {
      user = await this.oauth.token(bearer)
    } catch {
      // 过期、撤销或无效 Token 的 401 也必须携带 Bearer challenge，供客户端刷新或重新发现授权。
      res.set(
        'WWW-Authenticate',
        `Bearer error="invalid_token", resource_metadata="${env.publicUrl}/.well-known/oauth-protected-resource"`,
      )
      return res.status(401).json({ error: 'invalid_token' })
    }
    const server = new McpServer({ name: 'remote-code-mcp', version: '0.1.0' })
    registerMcpTools(server, this.hub, this.store, user.id, user.clientId)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    // 监听必须在处理请求前注册：同步结束的响应也要释放本次 MCP 资源。
    // close 事件同时覆盖客户端中断连接，且清理只执行一次。
    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      void Promise.allSettled([transport.close(), server.close()])
    }
    res.once('finish', cleanup)
    res.once('close', cleanup)
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      console.error('MCP handler', error instanceof Error ? error.name : 'UnknownError')
      if (!res.headersSent)
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        })
    } finally {
      if (res.writableEnded || res.destroyed) cleanup()
    }
  }
}
