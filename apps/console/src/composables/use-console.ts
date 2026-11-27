import { computed, onMounted, ref } from 'vue'
import { useDevices } from './use-devices'
import { useAuth } from './use-auth'
import { useConsoleData } from './use-console-data'
import { useOAuthGrants } from './use-oauth-grants'
import { useAdminActions } from './use-admin-actions'
import { useApprovalChannels } from './use-approval-channels'
import { useRoute, useRouter } from 'vue-router'
import { pagePaths } from '../page-paths'
import { ElMessage } from 'element-plus'
import { request, type User as Account } from '../api'

/** 区分用户主动取消弹窗和真正的接口失败，避免悄悄吞掉错误。 */
const reportError = (error: unknown) => {
  if (error === 'cancel' || error === 'close') return
  ElMessage.error(error instanceof Error ? error.message : '操作失败')
}

/** Console 页面业务模型（Composition API）。 */
export function useConsole() {
  const me = ref<Account | null>(null)
  const approvalChannels = useApprovalChannels(me)
  const loading = ref(true)
  const route = useRoute()
  const router = useRouter()
  const page = computed(() => String(route.name || 'overview'))
  const isAdmin = computed(() => ['admin', 'super_admin'].includes(me.value?.role || ''))
  /** MCP 对外连接地址与本地 API 代理不同，优先使用配置的服务端公开域名。 */
  const mcpUrl = computed(
    () => (import.meta.env.VITE_API_URL || window.location.origin).replace(/\/$/, '') + '/mcp',
  )

  /** 加载当前登录用户；未登录时清空用户状态，首次改密账号不加载业务数据。 */
  async function load() {
    try {
      me.value = await request<Account>('/api/auth/me')
      if (me.value && !me.value.passwordChangeRequired && !resumeOAuth()) await refresh()
    } catch {
      me.value = null
    } finally {
      loading.value = false
    }
  }

  const { refreshing, listRevision, devices, workspaces, stats, grants, refresh } = useConsoleData(
    me,
    isAdmin,
    reportError,
  )

  const {
    email,
    password,
    registering,
    authBusy,
    activationDialogOpen,
    activationEmail,
    clearActivationPrompt,
    resendBusy,
    resendSeconds,
    resendActivation,
    currentPassword,
    newPassword,
    newPasswordConfirm,
    signIn,
    resumeOAuth,
    changePassword,
    logout,
  } = useAuth(me, refresh, reportError)

  const { pairingCode, rename, revoke, approve } = useDevices(refresh, reportError)

  const { revokeGrant } = useOAuthGrants(refresh, reportError)

  const { adminRevoke, setUserStatus } = useAdminActions(refresh, reportError)

  /** 将页面标识映射到路由地址，保持侧栏导航与 URL 同步。 */
  function navigate(p: string) {
    const target = pagePaths[p]
    if (target) void router.push(target)
  }

  /** 复制 MCP 对外服务地址，供受支持的 AI 客户端配置连接。 */
  function copyUrl() {
    navigator.clipboard.writeText(mcpUrl.value)
    ElMessage.success('MCP URL 已复制')
  }

  onMounted(() => {
    // 等待初始路由就绪，避免首次加载时丢失 OAuth 查询参数。
    void router.isReady().then(load)
  })

  /** 页面标识到中文标题的映射，未匹配时统一使用默认标题。 */
  const pageTitles: Record<string, string> = {
    overview: '工作台概览',
    devices: '我的设备',
    workspaces: '工作区',
    connections: 'AI 连接',
    'approval-channels': '审批通知',
    history: '操作记录',
    activate: '绑定新设备',
    'admin-overview': '平台概览',
    'admin-users': '用户管理',
    'admin-devices': '平台设备',
    'admin-audit': '安全审计',
  }
  const title = computed(() => pageTitles[page.value] || '工作台')

  // 各页面只消费这里公开的响应式状态与动作，接口请求集中在本组合式函数中。
  return {
    me,
    approvalChannels,
    loading,
    refreshing,
    listRevision,
    page,
    email,
    password,
    registering,
    authBusy,
    activationDialogOpen,
    activationEmail,
    clearActivationPrompt,
    resendBusy,
    resendSeconds,
    resendActivation,
    devices,
    workspaces,
    stats,
    grants,
    pairingCode,
    currentPassword,
    newPassword,
    newPasswordConfirm,
    isAdmin,
    title,
    mcpUrl,
    load,
    refresh,
    signIn,
    changePassword,
    logout,
    rename,
    revoke,
    approve,
    revokeGrant,
    adminRevoke,
    setUserStatus,
    navigate,
    copyUrl,
  }
}

/** Console 根组件向各路由页面提供的响应式状态与业务动作。 */
export type ConsoleContext = ReturnType<typeof useConsole>
