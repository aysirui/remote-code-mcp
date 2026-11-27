import { All, Controller, Get, Delete, Param, Post, Put, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { env } from '../../config/env'
import { DeviceHub } from '../device/device-hub'
import { Store } from '../../infrastructure/database/store'
import { OAuthService } from '../oauth/oauth.service'
import { registerMcpTools } from './mcp-tools'

/** MCP HTTP 入口：/mcp 处理协议请求，/mcp/files 下处理原文件流；代理须保留原始路径。 */
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

  /** MCP 控制请求和上传领取使用同一套 OAuth 凭据校验。 */
  private async authenticate(req: Request, res: Response) {
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : ''
    if (!bearer) {
      res.set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${env.publicUrl}/.well-known/oauth-protected-resource"`,
      )
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    try {
      return await this.oauth.token(bearer)
    } catch {
      // 过期、撤销或无效 Token 的 401 也必须携带 Bearer challenge，供客户端刷新或重新发现授权。
      res.set(
        'WWW-Authenticate',
        `Bearer error="invalid_token", resource_metadata="${env.publicUrl}/.well-known/oauth-protected-resource"`,
      )
      res.status(401).json({ error: 'invalid_token' })
    }
  }

  /** 凭 id 领取一次性下载，传输层复查签发授权后返回原始字节。 */
  @Get('files/:id')
  async downloadFile(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    await this.hub.files.client(id, req, res)
  }

  /** 凭原 OAuth 客户端授权领取上传地址，消费请求中的原始字节。 */
  @Put('files/:id')
  async uploadFile(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const user = await this.authenticate(req, res)
    if (user) await this.hub.files.client(id, req, res, user)
  }

  /** 设备使用由已授权 RPC 单独下发的一次性凭证接入对应原文件流。 */
  @All('files/:id/device')
  async deviceFile(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    await this.hub.files.device(id, req, res)
  }

  /** 每次已认证请求独立创建 MCP Server 和 Transport，避免跨客户端状态共享。 */
  @Post()
  async post(@Req() req: Request, @Res() res: Response) {
    const user = await this.authenticate(req, res)
    if (!user) return
    const server = new McpServer({ name: 'remote-code-mcp', version: '0.1.0' })
    const { id, clientId, tokenHash } = user
    registerMcpTools(server, this.hub, this.store, id, clientId, async () => {
      await this.oauth.tokenByHash(tokenHash)
    })
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
