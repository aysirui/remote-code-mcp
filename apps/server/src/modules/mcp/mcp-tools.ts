import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { DeviceHub } from '../device/device-hub'
import { Store } from '../../infrastructure/database/store'
import { createMcpToolRegistrar } from './mcp-tool-registration'
import { listMcpDevices, listMcpWorkspaces } from './mcp-resource-list'
import { registerMcpOperationTools } from './mcp-operation-tools'

/** 为单次已认证的 MCP 请求注册工具；工具操作始终绑定当前用户与客户端。 */
export function registerMcpTools(
  server: McpServer,
  hub: DeviceHub,
  store: Store,
  userId: string,
  clientId: string,
) {
  const simple = createMcpToolRegistrar(server)
  simple('device_list', 'List your devices and their online status', {}, async () =>
    listMcpDevices(store, hub, userId),
  )
  simple(
    'workspace_list',
    'List authorized workspaces; choose workspaceId for other tools',
    {},
    async () => listMcpWorkspaces(store, hub, userId),
  )
  registerMcpOperationTools(simple, hub, userId, clientId)
}
