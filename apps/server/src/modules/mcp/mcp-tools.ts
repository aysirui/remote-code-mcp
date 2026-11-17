import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
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
  simple(
    'device_list',
    '列出当前用户的设备及其在线状态',
    McpToolInputs.device_list,
    McpToolOutputs.device_list,
    async () => listMcpDevices(store, hub, userId),
  )
  simple(
    'workspace_list',
    '列出已授权工作区及其权限、策略和在线状态；调用其他工具时使用返回的 workspaceId',
    McpToolInputs.workspace_list,
    McpToolOutputs.workspace_list,
    async () => listMcpWorkspaces(store, hub, userId),
  )
  registerMcpOperationTools(simple, hub, userId, clientId)
}
