import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import { operationRequiresWrite, type RpcRequest } from '@rcm/protocol'
import * as S from '../../infrastructure/database/schema'
import { Store } from '../../infrastructure/database/store'

/** 校验工作区和设备权限，返回授权设备的 ID 及控制台显示名。 */
export async function authorizeDeviceRpc(
  store: Store,
  userId: string,
  workspaceId: string,
  operation: RpcRequest['operation'],
) {
  const workspace = await store.one(
    store.db
      .select()
      .from(S.workspaces)
      .where(
        and(
          eq(S.workspaces.id, workspaceId),
          eq(S.workspaces.userId, userId),
          eq(S.workspaces.localEnabled, true),
        ),
      )
      .limit(1),
  )
  if (!workspace) throw new NotFoundException('WORKSPACE_NOT_FOUND')
  if (!workspace.localRead || (operationRequiresWrite(operation) && !workspace.localWrite))
    throw new ForbiddenException('PERMISSION_DENIED')
  const device = await store.one(
    store.db
      .select()
      .from(S.devices)
      .where(and(eq(S.devices.id, workspace.deviceId), eq(S.devices.userId, userId)))
      .limit(1),
  )
  if (!device || device.status !== 'active') throw new ForbiddenException('DEVICE_REVOKED')
  return { id: device.id, name: device.name }
}
