import { eq } from 'drizzle-orm'
import { DeviceHub } from '../device/device-hub'
import { Store } from '../../infrastructure/database/store'
import * as S from '../../infrastructure/database/schema'

/** 查询当前用户设备摘要；在线状态仅来自实时连接，不持久化到设备记录。 */
export async function listMcpDevices(store: Store, hub: DeviceHub, userId: string) {
  const devices = await store.db.select().from(S.devices).where(eq(S.devices.userId, userId))
  return devices.map((device) => ({
    id: device.id,
    name: device.name,
    online: hub.isOnline(device.id),
    status: device.status,
  }))
}

/** 查询当前用户已授权工作区，避免向 MCP 客户端泄露 Runtime 本地路径。 */
export async function listMcpWorkspaces(store: Store, hub: DeviceHub, userId: string) {
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
}
