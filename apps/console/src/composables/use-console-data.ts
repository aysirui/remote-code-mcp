import { ref, type Ref, type ComputedRef } from 'vue'
import {
  request,
  type Device,
  type Workspace,
  type OAuthGrant,
  type OverviewStats,
  type User as Account,
} from '../api'

/** 集中加载 Console 摘要数据；日志和审计分页仍由各自页面按需请求。 */
export function useConsoleData(
  me: Ref<Account | null>,
  isAdmin: ComputedRef<boolean>,
  reportError: (error: unknown) => void,
) {
  const refreshing = ref(false)
  const listRevision = ref(0)
  const devices = ref<Device[]>([])
  const workspaces = ref<Workspace[]>([])
  const stats = ref<OverviewStats>({ users: 0, devices: 0, online: 0, workspaces: 0 })
  const grants = ref<OAuthGrant[]>([])

  /** 操作记录和安全审计分别加载，避免将 MCP 工具调用混入安全审计。 */
  async function refresh() {
    if (!me.value || me.value.passwordChangeRequired || refreshing.value) return
    refreshing.value = true
    listRevision.value++
    try {
      ;[devices.value, workspaces.value, grants.value] = await Promise.all([
        request<Device[]>('/api/me/devices'),
        request<Workspace[]>('/api/me/workspaces'),
        request<OAuthGrant[]>('/api/me/oauth-grants'),
      ])
      if (isAdmin.value) {
        ;[stats.value] = await Promise.all([request<OverviewStats>('/api/admin/overview')])
      }
    } catch (error: unknown) {
      reportError(error)
    } finally {
      refreshing.value = false
    }
  }

  return { refreshing, listRevision, devices, workspaces, stats, grants, refresh }
}
