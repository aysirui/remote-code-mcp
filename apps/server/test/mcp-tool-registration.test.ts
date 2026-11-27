import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpToolInputs, McpToolOutputs, type RpcRequest } from '@rcm/protocol'
import type { Store } from '../src/infrastructure/database/store'
import type { DeviceHub } from '../src/modules/device/device-hub'
import { register } from '../src/modules/mcp/tools/register'
import { registerMcpTools } from '../src/modules/mcp/mcp-tools'
import { DeviceRpcError } from '../src/modules/device/device-rpc-pending'

describe('MCP 工具结果包装', () => {
  test.each(['文件正文\n', '正文中已有\n\nSHA-256: 文件原文\n', ''])(
    '读取文件时正文与摘要保持独立：%j',
    async (content) => {
      const registerTool = jest.fn()
      const context = {
        hub: {} as DeviceHub,
        store: {} as Store,
        userId: 'user-1',
        clientId: 'client-1',
        authorizeDownload: async () => {},
      }
      const data = {
        content,
        sha256: 'a'.repeat(64),
        encoding: 'utf8',
        mimeType: 'text/plain',
        size: Buffer.byteLength(content),
      }
      register(
        { registerTool } as unknown as McpServer,
        {
          name: 'file_read',
          description: '读取文件',
          inputSchema: McpToolInputs['file.read'],
          outputSchema: McpToolOutputs['file.read'],
          execute: async () => data,
        },
        context,
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
  const prepareFileTransfer = jest.fn()
  const where = jest.fn()

  beforeEach(async () => {
    execute.mockReset()
    preview.mockReset()
    prepareFileTransfer.mockReset()
    where.mockReset()
    server = new McpServer({ name: 'rcm-test', version: '1.0.0' })
    client = new Client({ name: 'rcm-test-client', version: '1.0.0' })
    const hub = {
      execute,
      files: { readPreview: preview },
      prepareFileTransfer,
      isOnline: () => true,
    } as unknown as DeviceHub
    const store = {
      db: { select: () => ({ from: () => ({ where }) }) },
    } as unknown as Store
    registerMcpTools(server, hub, store, 'user-1', 'client-1', async () => {})
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
    expect(tools).toHaveLength(18)
    for (const tool of tools) {
      expect(tool.outputSchema).toMatchObject({ type: 'object' })
    }
    expect(
      tools
        .filter(({ annotations }) => annotations?.readOnlyHint === false)
        .map(({ name }) => name)
        .sort(),
    ).toEqual([
      'command_run',
      'file_delete',
      'file_mkdir',
      'file_move',
      'file_write',
      'git_add',
      'git_commit',
    ])
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

  test('图片预览工具声明可读取的组件资源，读取失败时不返回组件图片数据', async () => {
    const { tools } = await client.listTools()
    const tool = tools.find(({ name }) => name === 'file_preview')
    const uri = 'ui://rcm/file-preview-v3.html'
    expect(tool).toMatchObject({
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: uri } },
    })
    const resource = await client.readResource({ uri })
    expect(resource.contents).toEqual([
      expect.objectContaining({
        uri,
        mimeType: 'text/html;profile=mcp-app',
        text: expect.stringContaining('ui/notifications/tool-result'),
      }),
    ])
    preview.mockImplementationOnce(async (run) =>
      run({ id: 'transfer-1', key: 'test-transfer-key' }),
    )
    execute.mockRejectedValueOnce(new DeviceRpcError('POLICY_DENIED'))
    const result = await client.callTool({
      name: 'file_preview',
      arguments: { workspaceId: 'workspace-1', path: 'images/logo.png' },
    })
    expect(execute).toHaveBeenLastCalledWith('user-1', 'client-1', 'workspace-1', 'file.read', {
      path: 'images/logo.png',
      encoding: 'stream',
      mediaPreview: true,
      transfer: { id: 'transfer-1', key: 'test-transfer-key' },
    })
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'POLICY_DENIED' }],
    })
    expect(result._meta).toBeUndefined()
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

  test('MCP 文件查询、读取和覆盖调用保留设备返回的文件缺失状态', async () => {
    const args = { workspaceId: 'workspace-1', path: 'missing.txt' }
    for (const name of ['file_stat', 'file_read', 'file_write']) {
      execute.mockRejectedValueOnce(new DeviceRpcError('FILE_NOT_FOUND'))
      const input =
        name === 'file_write' ? { ...args, content: '正文', expectedSha256: 'a'.repeat(64) } : args
      const result = await client.callTool({ name, arguments: input })
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'FILE_NOT_FOUND' }],
      })
    }
    expect(execute).toHaveBeenCalledTimes(3)
  })

  test('文件读取工具声明文本和下载模式，默认读取文本', async () => {
    const { tools } = await client.listTools()
    expect(tools.find(({ name }) => name === 'file_read')).toMatchObject({
      inputSchema: { properties: { encoding: { enum: ['utf8', 'stream'], default: 'utf8' } } },
      outputSchema: { properties: { encoding: { enum: ['utf8', 'stream'] } } },
    })
  })

  test('原文件下载模式返回领取凭据，媒体预览仍向卡片提供字节', async () => {
    const args = { workspaceId: 'workspace-1', path: 'image.png' }
    const ticket = { method: 'GET', url: 'https://rcm.example/mcp/files/ticket', expiresAt: 12345 }
    prepareFileTransfer.mockResolvedValueOnce(ticket)
    const download = await client.callTool({
      name: 'file_read',
      arguments: { ...args, encoding: 'stream' },
    })
    const expected = { encoding: 'stream', ...ticket }
    expect(download).toEqual({
      structuredContent: expected,
      content: [{ type: 'text', text: JSON.stringify(expected) }],
    })

    const metadata = { mimeType: 'image/png', size: 3, sha256: 'a'.repeat(64) }
    const bytes = Buffer.from([1, 2, 3])
    preview.mockResolvedValueOnce({ metadata: { ...metadata, encoding: 'stream' }, bytes })
    const card = await client.callTool({ name: 'file_preview', arguments: args })
    expect(card).toMatchObject({
      structuredContent: { ...metadata, name: 'image.png' },
      _meta: { 'rcm/previewMedia': bytes.toString('base64') },
    })
  })

  test('不支持预览的文件返回业务错误且不提供卡片媒体数据', async () => {
    preview.mockRejectedValueOnce(new DeviceRpcError('FILE_PREVIEW_UNSUPPORTED'))
    const card = await client.callTool({
      name: 'file_preview',
      arguments: { workspaceId: 'workspace-1', path: 'file.pdf' },
    })
    expect(card).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'FILE_PREVIEW_UNSUPPORTED' }],
    })
    expect(card._meta).toBeUndefined()
  })

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
      { name: 'file_write', arguments: { path: 'a.png', encoding: 'attachment' } },
      {
        name: 'file_write',
        arguments: {
          path: 'a.png',
          encoding: 'attachment',
          size: 4,
          file: { file_id: 'file-1', download_url: 'https://files.example.net/sample' },
        },
      },
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
