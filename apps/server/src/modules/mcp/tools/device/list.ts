import { McpToolInputs, McpToolOutputs } from '@rcm/protocol'
import { eq } from 'drizzle-orm'
import * as S from '../../../../infrastructure/database/schema'
import type { McpToolDefinition } from '../register'

/** device_list 只查询当前用户的设备，在线状态来自实时连接。 */
export const deviceList = {
  name: 'device_list',
  description: '列出当前用户的设备及其在线状态',
  inputSchema: McpToolInputs.device_list,
  outputSchema: McpToolOutputs.device_list,
  async execute(_args, { store, hub, userId }) {
    const devices = await store.db.select().from(S.devices).where(eq(S.devices.userId, userId))
    return devices.map((device) => ({
      id: device.id,
      name: device.name,
      online: hub.isOnline(device.id),
      status: device.status,
    }))
  },
} satisfies McpToolDefinition<typeof McpToolInputs.device_list, unknown>
