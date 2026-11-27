import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import { eq } from 'drizzle-orm'
import * as S from '../../../../infrastructure/database/schema'
import type { McpToolDefinition } from '../register'

/** workspace_list 返回当前用户的工作区和授权状态，省略 Runtime 本地路径。 */
export const workspaceList = {
  name: 'workspace_list',
  description: '列出已授权工作区及其权限、策略和在线状态；调用其他工具时使用返回的 workspaceId',
  inputSchema: McpToolInputs.workspace_list,
  outputSchema: McpToolOutputs.workspace_list,
  async execute(_args, { store, hub, userId }) {
    const workspaces = await store.db
      .select()
      .from(S.workspaces)
      .where(eq(S.workspaces.userId, userId))
    return workspaces.map((workspace) => ({
      workspaceId: workspace.id,
      name: workspace.name,
      deviceId: workspace.deviceId,
      read: workspace.localEnabled && workspace.localRead,
      write: workspace.localEnabled && workspace.localRead && workspace.localWrite,
      enabled: workspace.localEnabled,
      policies: {
        file: workspace.localFilePolicy,
        git: workspace.localGitPolicy,
        command: workspace.localCommandPolicy,
      },
      online: hub.isOnline(workspace.deviceId),
    }))
  },
} satisfies McpToolDefinition<typeof McpToolInputs.workspace_list, unknown>
