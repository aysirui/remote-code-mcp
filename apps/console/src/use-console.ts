import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { pagePaths, router } from './router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  request,
  type Device,
  type Workspace,
  type User as Account,
  type OAuthGrant,
  type OverviewStats,
} from './api'

/** 区分用户主动取消弹窗和真正的接口失败，避免悄悄吞掉错误。 */
const reportError = (error: unknown) => {
  if (error === 'cancel' || error === 'close') return
  ElMessage.error(error instanceof Error ? error.message : '操作失败')
}

/** Console 页面业务模型（Composition API）。 */
export function useConsole() {
  const me = ref<Account | null>(null)
  const loading = ref(true)
  const refreshing = ref(false)
  const listRevision = ref(0)
  const route = useRoute()
  const page = computed(() => String(route.name || 'overview'))
  const email = ref('')
  const password = ref('')
  const registering = ref(false)
  const devices = ref<Device[]>([])
  const workspaces = ref<Workspace[]>([])
  const stats = ref<OverviewStats>({ users: 0, devices: 0, online: 0, workspaces: 0 })
  const grants = ref<OAuthGrant[]>([])
  const pairingCode = ref('')
  const currentPassword = ref('')
  const newPassword = ref('')
  const newPasswordConfirm = ref('')
  const isAdmin = computed(() => ['admin', 'super_admin'].includes(me.value?.role || ''))
  /** MCP 对外连接地址与本地 API 代理不同，优先使用配置的服务端公开域名。 */
  const mcpUrl = computed(
    () => (import.meta.env.VITE_API_URL || window.location.origin).replace(/\/$/, '') + '/mcp',
  )
  const location = window.location
  const q = new URLSearchParams(location.search)
  const returnTo = q.get('returnTo')

  /** 加载当前登录用户；未登录时清空用户状态，首次改密账号不加载业务数据。 */
  async function load() {
    try {
      me.value = await request<Account>('/api/auth/me')
      if (!me.value?.passwordChangeRequired) await refresh()
    } catch {
      me.value = null
    } finally {
      loading.value = false
    }
  }

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

  /** 处理注册与登录；首次管理员登录必须先完成临时密码修改。 */
  async function signIn() {
    try {
      if (registering.value) {
        await request('/api/auth/register', 'POST', {
          email: email.value,
          password: password.value,
        })
        ElMessage.success('注册成功，请登录')
        registering.value = false
        return
      }
      me.value = await request<Account>('/api/auth/login', 'POST', {
        email: email.value,
        password: password.value,
      })
      if (me.value?.passwordChangeRequired) {
        currentPassword.value = password.value
        password.value = ''
        ElMessage.warning('首次登录请先修改临时密码')
        return
      }
      if (returnTo) {
        const target = new URL(returnTo)
        const allow = new URL(import.meta.env.VITE_API_URL || location.origin)
        if (target.origin === allow.origin) {
          location.href = target.toString()
          return
        }
      }
      await refresh()
      ElMessage.success('登录成功')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 校验新密码确认值后提交修改；成功后要求用户使用新密码重新登录。 */
  async function changePassword() {
    if (!currentPassword.value || !newPassword.value) {
      ElMessage.warning('请输入旧密码和新密码')
      return
    }
    if (newPassword.value !== newPasswordConfirm.value) {
      ElMessage.error('两次输入的新密码不一致')
      return
    }
    try {
      await request('/api/auth/change-password', 'POST', {
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
      })
      currentPassword.value = ''
      newPassword.value = ''
      newPasswordConfirm.value = ''
      me.value = null
      password.value = ''
      ElMessage.success('密码修改成功，请使用新密码重新登录')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 注销当前 Session 并返回 Console 入口。 */
  async function logout() {
    await request('/api/auth/logout', 'POST')
    me.value = null
    await router.push('/console')
  }

  /** 修改当前用户设备的显示名称；接口失败时保留原列表状态。 */
  async function rename(d: Device) {
    try {
      const { value } = await ElMessageBox.prompt('设备名称', '重命名设备', {
        inputValue: d.name,
        inputValidator: (v) => v.trim().length > 0,
      })
      await request(`/api/me/devices/${d.id}`, 'PATCH', { name: value })
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 经用户二次确认后撤销设备凭据，并刷新设备与工作区授权状态。 */
  async function revoke(d: Device) {
    try {
      await ElMessageBox.confirm(
        `解绑后 ${d.name} 将立刻无法访问本平台，需重新配对。`,
        '确认解绑',
        { type: 'warning', confirmButtonText: '解绑设备', confirmButtonType: 'danger' },
      )
      await request(`/api/me/devices/${d.id}`, 'DELETE')
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 提交一次性配对码，将 Runtime 设备绑定到当前平台账号。 */
  async function approve() {
    try {
      await request('/api/device/pairing/approve', 'POST', { code: pairingCode.value })
      pairingCode.value = ''
      ElMessage.success('设备绑定成功')
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 撤销指定 OAuth 客户端的持久授权及其令牌。 */
  async function revokeGrant(g: OAuthGrant) {
    try {
      await ElMessageBox.confirm(
        '撤销后，相关 AI 客户端需要重新授权才能调用 MCP 工具。',
        '撤销 AI 连接',
        { type: 'warning', confirmButtonText: '撤销连接', confirmButtonType: 'danger' },
      )
      await request('/api/me/oauth-grants/' + encodeURIComponent(g.clientId), 'DELETE')
      await refresh()
      ElMessage.success('授权已撤销')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 管理员撤销指定设备的凭据并立即断开其连接。 */
  async function adminRevoke(d: Device) {
    try {
      await ElMessageBox.confirm('撤销后设备必须重新绑定。', '管理员撤销设备', {
        type: 'warning',
        confirmButtonText: '撤销设备',
        confirmButtonType: 'danger',
      })
      await request('/api/admin/devices/' + d.id + '/revoke', 'POST')
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 管理员启用或禁用普通用户；服务端负责撤销其 Session 和 OAuth 凭据。 */
  async function setUserStatus(u: Account) {
    try {
      await ElMessageBox.confirm(
        `确定将 ${u.email} 设为${u.status === 'active' ? '禁用' : '启用'}？`,
        '账户状态',
      )
      await request(`/api/admin/users/${u.id}/status`, 'PATCH', {
        status: u.status === 'active' ? 'disabled' : 'active',
      })
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }

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
    void load()
  })

  /** 页面标识到中文标题的映射，未匹配时统一使用默认标题。 */
  const pageTitles: Record<string, string> = {
    overview: '工作台概览',
    devices: '我的设备',
    workspaces: '工作区',
    connections: 'AI 连接',
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
    loading,
    refreshing,
    listRevision,
    page,
    email,
    password,
    registering,
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
