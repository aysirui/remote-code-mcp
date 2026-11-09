import type { Express, Request, Response } from 'express'
import { operationRequiresWrite, type RpcRequest } from '@rcm/protocol'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { DeviceHub, Store } from './core'
import { OAuthService } from './oauth'
import * as S from './schema'
import { eq } from 'drizzle-orm'

export function installMcp(expressApp: Express, oauth: OAuthService, hub: DeviceHub, store: Store) {
  expressApp.get('/mcp', (_req: Request, res: Response) => res.status(405).end())
  expressApp.delete('/mcp', (_req: Request, res: Response) => res.status(405).end())
  expressApp.post('/mcp', async (req: Request, res: Response) => {
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : ''
    if (!bearer) {
      res.set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${process.env.PUBLIC_URL || 'http://localhost:3000'}/.well-known/oauth-protected-resource"`,
      )
      return res.status(401).json({ error: 'unauthorized' })
    }
    let user
    try {
      user = await oauth.token(bearer)
    } catch {
      return res.status(401).json({ error: 'invalid_token' })
    }
    const userId = user.id
    const server = new McpServer({ name: 'remote-code-mcp', version: '0.1.0' })
    const simple = (
      name: string,
      description: string,
      inputSchema: Record<string, z.ZodTypeAny>,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
      readOnly = true,
    ) =>
      server.registerTool(
        name,
        { description, inputSchema, annotations: { readOnlyHint: readOnly } },
        async (args) => {
          try {
            const data = await handler(args)
            const objectData =
              typeof data === 'object' && data !== null && !Array.isArray(data)
                ? (data as Record<string, unknown>)
                : null
            const readable =
              objectData && typeof objectData.content === 'string'
                ? objectData.content +
                  (typeof objectData.sha256 === 'string' ? '\n\nSHA-256: ' + objectData.sha256 : '')
                : typeof data === 'string'
                  ? data
                  : (JSON.stringify(data) ?? 'null')
            return {
              content: [{ type: 'text' as const, text: readable }],
              structuredContent: objectData ?? { value: data },
            }
          } catch (error: unknown) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
              isError: true,
            }
          }
        },
      )
    simple('device_list', 'List your devices and their online status', {}, async () => {
      const ds = await store.db.select().from(S.devices).where(eq(S.devices.userId, userId))
      return ds.map((d) => ({
        id: d.id,
        name: d.name,
        online: hub.isOnline(d.id),
        status: d.status,
      }))
    })
    simple(
      'workspace_list',
      'List authorized workspaces; choose workspaceId for other tools',
      {},
      async () => {
        const ws = await store.db.select().from(S.workspaces).where(eq(S.workspaces.userId, userId))
        return ws.map((w) => ({
          workspaceId: w.id,
          name: w.name,
          deviceId: w.deviceId,
          read: w.localEnabled && w.cloudEnabled && w.localRead && w.cloudRead,
          write:
            w.localEnabled &&
            w.cloudEnabled &&
            w.localRead &&
            w.cloudRead &&
            w.localWrite &&
            w.cloudWrite,
          enabled: w.localEnabled && w.cloudEnabled,
          online: hub.isOnline(w.deviceId),
        }))
      },
    )
    const exec = (op: RpcRequest['operation'], fields: Record<string, z.ZodTypeAny>) =>
      simple(
        op.replace('.', '_'),
        `Execute ${op} on your authorized local workspace`,
        { workspaceId: z.string(), ...fields },
        async (args) => {
          const { workspaceId, ...payload } = args
          return hub.execute(userId, String(workspaceId), op, payload)
        },
        !operationRequiresWrite(op),
      )
    exec('file.list', { path: z.string().default('.') })
    exec('file.read', { path: z.string() })
    exec('file.search', { path: z.string().default('.'), query: z.string() })
    exec('file.write', {
      path: z.string(),
      content: z.string().max(524288),
      expectedSha256: z.string().optional(),
    })
    exec('file.mkdir', {
      path: z.string().min(1).max(500),
      recursive: z.boolean().default(false),
    })
    exec('file.move', {
      from: z.string().min(1).max(500),
      to: z.string().min(1).max(500),
    })
    exec('file.delete', {
      path: z.string().min(1).max(500),
      recursive: z.boolean().default(false),
      expectedSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    exec('command.list', {})
    exec('command.run', {
      command: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
    })
    exec('git.status', {})
    exec('git.diff', {})
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (e) {
      console.error('MCP handler', e)
      if (!res.headersSent)
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        })
    } finally {
      res.on('finish', () => {
        void transport.close()
        void server.close()
      })
    }
  })
}
