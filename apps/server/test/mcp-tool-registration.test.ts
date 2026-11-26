import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpToolInputs, McpToolOutputs, type RpcRequest } from '@rcm/protocol'
import type { Store } from '../src/infrastructure/database/store'
import type { DeviceHub } from '../src/modules/device/device-hub'
import { createMcpToolRegistrar } from '../src/modules/mcp/mcp-tool-registration'
import { registerMcpTools } from '../src/modules/mcp/mcp-tools'
import { DeviceRpcError } from '../src/modules/device/device-rpc-pending'

describe('MCP 工具结果包装', () => {
  test.each(['文件正文\n', '正文中已有\n\nSHA-256: 文件原文\n', ''])(
    '读取文件时正文与摘要保持独立：%j',
    async (content) => {
      const registerTool = jest.fn()
      const register = createMcpToolRegistrar({ registerTool } as unknown as McpServer)
      const data = {
        content,
        sha256: 'a'.repeat(64),
        encoding: 'utf8',
        mimeType: 'text/plain',
        size: Buffer.byteLength(content),
      }
      register(
        'file_read',
        '读取文件',
        McpToolInputs['file.read'],
        McpToolOutputs['file.read'],
        async () => data,
      )

      const handler = registerTool.mock.calls[0][2] as (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>
        structuredContent: Record<string, unknown>
      }>
      const result = await handler({})

      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(data) }])
      expect(JSON.parse(result.content[0].text)).toEqual(data)
      expect(result.structuredContent).toEqual(data)
    },
  )
})

describe('MCP 输出契约', () => {
  let server: McpServer
  let client: Client
  const execute = jest.fn()
  const preview = jest.fn()
  const where = jest.fn()

  beforeEach(async () => {
    execute.mockReset()
    preview.mockReset()
    where.mockReset()
    server = new McpServer({ name: 'rcm-test', version: '1.0.0' })
    client = new Client({ name: 'rcm-test-client', version: '1.0.0' })
    const hub = { execute, files: { preview }, isOnline: () => true } as unknown as DeviceHub
    const store = {
      db: { select: () => ({ from: () => ({ where }) }) },
    } as unknown as Store
    registerMcpTools(server, hub, store, 'user-1', 'client-1')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
  })

  afterEach(async () => {
    await client.close()
    await server.close()
  })

  test('客户端可发现所有工具的输出契约，并读取设备和工作区列表', async () => {
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(16)
    for (const tool of tools) {
      expect(tool.outputSchema).toMatchObject({ type: 'object' })
    }
    const device = { id: 'device-1', name: '本机', status: 'active' }
    where.mockResolvedValueOnce([device])
    expect(await client.callTool({ name: 'device_list' })).toMatchObject({
      structuredContent: { value: [{ ...device, online: true }] },
    })
    const policies = { file: 'approval', git: 'allow', command: 'deny' }
    where.mockResolvedValueOnce([
      {
        id: 'workspace-1',
        name: '项目',
        deviceId: device.id,
        localEnabled: true,
        localRead: true,
        localWrite: false,
        localFilePolicy: policies.file,
        localGitPolicy: policies.git,
        localCommandPolicy: policies.command,
      },
    ])
    expect(await client.callTool({ name: 'workspace_list' })).toMatchObject({
      structuredContent: {
        value: [
          {
            workspaceId: 'workspace-1',
            name: '项目',
            deviceId: device.id,
            enabled: true,
            read: true,
            write: false,
            policies,
            online: true,
          },
        ],
      },
    })
  })

  test('各领域成功结果与声明匹配，保留对象、数组和字符串的现有包装', async () => {
    await client.listTools()
    const sha256 = 'a'.repeat(64)
    const cases: Array<{
      operation: RpcRequest['operation']
      args: Record<string, unknown>
      data: unknown
    }> = [
      {
        operation: 'file.list',
        args: {},
        data: [
          { name: 'src', type: 'directory' },
          { name: 'a.ts', type: 'file' },
        ],
      },
      {
        operation: 'file.read',
        args: { path: 'a.ts' },
        data: { content: '正文\n', sha256, encoding: 'utf8', mimeType: 'text/plain', size: 7 },
      },
      {
        operation: 'file.search',
        args: { query: '正文' },
        data: [{ path: 'a.ts', line: 1, text: '正文' }],
      },
      {
        operation: 'file.write',
        args: { path: 'a.ts', content: '正文' },
        data: { path: 'a.ts', sha256, written: true },
      },
      {
        operation: 'file.mkdir',
        args: { path: 'src', recursive: true },
        data: { path: 'src', created: false },
      },
      {
        operation: 'file.move',
        args: { from: 'a.ts', to: 'b.ts' },
        data: { from: 'a.ts', to: 'b.ts', moved: true },
      },
      { operation: 'file.delete', args: { path: 'b.ts' }, data: { path: 'b.ts', deleted: true } },
      { operation: 'git.status', args: {}, data: ' M a.ts' },
      {
        operation: 'git.log',
        args: {},
        data: [{ hash: 'abc1234', date: '2026-11-17', author: '开发者', subject: '修复问题' }],
      },
      { operation: 'git.diff', args: {}, data: '' },
      { operation: 'git.add', args: { paths: ['a.ts'] }, data: { staged: ['a.ts'], output: '' } },
      {
        operation: 'git.commit',
        args: { message: '修复问题' },
        data: { committed: ['a.ts'], tree: 'b'.repeat(40), output: '提交完成' },
      },
      { operation: 'command.list', args: {}, data: [{ id: 'build', name: '构建' }] },
      {
        operation: 'command.run',
        args: { command: 'build' },
        data: { command: 'build', exitCode: 0, output: '完成', truncated: false },
      },
      {
        operation: 'command.run',
        args: { command: 'build' },
        data: { command: 'build', exitCode: null, output: '\nCOMMAND_TIMEOUT', truncated: true },
      },
    ]
    for (const { operation, args, data } of cases) {
      execute.mockResolvedValueOnce(data)
      const result = await client.callTool({
        name: operation.replace('.', '_'),
        arguments: { workspaceId: 'workspace-1', ...args },
      })
      expect(result.isError).toBeUndefined()
      const structured = typeof data === 'object' && !Array.isArray(data) ? data : { value: data }
      expect(result.structuredContent).toEqual(structured)
      expect(execute).toHaveBeenLastCalledWith(
        'user-1',
        'client-1',
        'workspace-1',
        operation,
        expect.any(Object),
      )
    }
  })

  test('缺少摘要的读取结果被拒绝，业务错误仍按错误结果返回', async () => {
    await client.listTools()
    execute.mockResolvedValueOnce({ content: '缺少摘要' })
    const invalid = await client.callTool({
      name: 'file_read',
      arguments: { workspaceId: 'workspace-1', path: 'a.ts' },
    })
    expect(invalid.isError).toBe(true)
    expect(invalid.content).toEqual([{ type: 'text', text: 'INVALID_TOOL_RESULT' }])
    execute.mockRejectedValueOnce(new DeviceRpcError('WORKSPACE_DISABLED'))
    const failed = await client.callTool({
      name: 'file_read',
      arguments: { workspaceId: 'workspace-1', path: 'a.ts' },
    })
    expect(failed).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'WORKSPACE_DISABLED' }],
    })
    expect(failed.structuredContent).toBeUndefined()
  })

  test.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])(
    'MIME 为 %s 的读取结果统一生成 MCP 图片块',
    async (mimeType) => {
      const metadata = { mimeType, encoding: 'preview', size: 2, sha256: 'a'.repeat(64) }
      const content = '/9g='
      preview.mockResolvedValueOnce({ metadata, bytes: Buffer.from(content, 'base64') })
      const result = await client.callTool({
        name: 'file_read',
        arguments: { workspaceId: 'workspace-1', path: 'asset', encoding: 'preview' },
      })
      expect(result.structuredContent).toEqual(metadata)
      const [summary, image] = result.content as CallToolResult['content']
      expect(summary.type).toBe('text')
      if (summary.type === 'text') expect(JSON.parse(summary.text)).toEqual(metadata)
      expect(image).toEqual({ type: 'image', data: content, mimeType })
    },
  )

  test.each(['COMMAND_EXIT_NONZERO', 'COMMAND_PROCESS_TERMINATED', 'COMMAND_TIMEOUT'])(
    '命令失败 %s 标记为 MCP 错误并保留输出',
    async (code) => {
      const data = {
        command: 'build',
        exitCode: code === 'COMMAND_EXIT_NONZERO' ? 2 : null,
        output: '部分输出',
        truncated: true,
      }
      execute.mockRejectedValueOnce(new DeviceRpcError(code, data))
      const failed = await client.callTool({
        name: 'command_run',
        arguments: { workspaceId: 'workspace-1', command: 'build' },
      })
      expect(failed.isError).toBe(true)
      expect(failed.content).toEqual([{ type: 'text', text: JSON.stringify({ code, ...data }) }])
    },
  )

  test('未分类的工具异常只返回稳定错误码，不泄露内部异常内容', async () => {
    where.mockRejectedValueOnce(new Error('数据库连接串不对外暴露'))
    const failed = await client.callTool({ name: 'device_list' })
    expect(failed).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'TOOL_EXECUTION_FAILED' }],
    })
  })

  test('MCP 使用共享输入限制，拒绝无效搜索与混用的命令参数且不转发设备', async () => {
    const invalidInputs = [
      { name: 'file_search', arguments: { query: '' } },
      { name: 'file_search', arguments: { query: 'a'.repeat(201) } },
      { name: 'file_read', arguments: { path: '' } },
      { name: 'file_write', arguments: { path: 'a.png', encoding: 'stream' } },
      {
        name: 'file_write',
        arguments: { path: 'a.png', encoding: 'stream', size: 4, content: 'abcd' },
      },
      { name: 'file_write', arguments: { path: 'a.png', size: 4, content: 'abcd' } },
      { name: 'command_run', arguments: {} },
      { name: 'command_run', arguments: { command: 'build', args: [] } },
      { name: 'command_run', arguments: { command: 'build', executable: 'node' } },
      { name: 'command_run', arguments: { executable: 'no\nde' } },
      { name: 'command_run', arguments: { command: 'build', timeoutMs: 900000 } },
    ]
    for (const input of invalidInputs) {
      const result = await client.callTool({
        name: input.name,
        arguments: { workspaceId: 'workspace-1', ...input.arguments },
      })
      expect(result.isError).toBe(true)
    }
    expect(execute).not.toHaveBeenCalled()
  })

  test('MCP 转发保留普通输入默认值，并按共享命令契约补齐临时命令参数', async () => {
    execute.mockResolvedValueOnce([])
    const search = await client.callTool({
      name: 'file_search',
      arguments: { workspaceId: 'workspace-1', query: '正文' },
    })
    expect(search.isError).toBeUndefined()
    expect(execute).toHaveBeenLastCalledWith('user-1', 'client-1', 'workspace-1', 'file.search', {
      path: '.',
      query: '正文',
    })
    execute.mockResolvedValueOnce({ command: 'node', exitCode: 0, output: '', truncated: false })
    const temporary = await client.callTool({
      name: 'command_run',
      arguments: { workspaceId: 'workspace-1', executable: 'node' },
    })
    expect(temporary.isError).toBeUndefined()
    expect(execute).toHaveBeenLastCalledWith('user-1', 'client-1', 'workspace-1', 'command.run', {
      executable: 'node',
      args: [],
    })
  })
})
