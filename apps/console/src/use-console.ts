import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

/** 区分用户主动取消弹窗和真正的接口失败，避免悄悄吞掉错误。 */
const reportError = (error: unknown) => {
  if (error === 'cancel' || error === 'close') return
  ElMessage.error(error instanceof Error ? error.message : '操作失败')
}

import {
  request,
  base,
  type Device,
  type Workspace,
  type User as Account,
  type AuditLog,
  type OAuthGrant,
  type OverviewStats,
} from './api'

/**
 * Console 页面业务模型（Composition API）。
 * 登录/管理员/设备/工作区行为集中在此，App.vue 只维护页面模板。
 */
export function useConsole() {
  const me = ref<Account | null>(null),
    loading = ref(true),
    page = ref(window.location.pathname.startsWith('/admin') ? 'admin-overview' : 'overview')
  const email = ref(''),
    password = ref(''),
    registering = ref(false),
    devices = ref<Device[]>([]),
    workspaces = ref<Workspace[]>([]),
    users = ref<Account[]>([]),
    logs = ref<AuditLog[]>([]),
    adminDevices = ref<Device[]>([]),
    adminLogs = ref<AuditLog[]>([]),
    stats = ref<OverviewStats>({ users: 0, devices: 0, online: 0, workspaces: 0 }),
    grants = ref<OAuthGrant[]>([])
  const pairingCode = ref('')
  const currentPassword = ref('')
  const newPassword = ref('')
  const newPasswordConfirm = ref('')
  const isAdmin = computed(() => ['admin', 'super_admin'].includes(me.value?.role || ''))
  /** 面向 UI 的 MCP 连接地址，统一使用配置的后端域名。 */
  const mcpUrl = computed(() => (base || window.location.origin) + '/mcp')
  const location = window.location
  const q = new URLSearchParams(location.search),
    returnTo = q.get('returnTo')
  /** 加载当前登录用户；未登录时清空页面状态，首次改密账号不加载业务数据。 */
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
  /** 并行获取当前用户的设备、工作区、审计和授权信息；管理员额外获取管理视图。 */
  async function refresh() {
    if (!me.value || me.value.passwordChangeRequired) return
    try {
      ;[devices.value, workspaces.value, logs.value, grants.value] = await Promise.all([
        request<Device[]>('/api/me/devices'),
        request<Workspace[]>('/api/me/workspaces'),
        request<AuditLog[]>('/api/me/audit-logs'),
        request<OAuthGrant[]>('/api/me/oauth-grants'),
      ])
      if (isAdmin.value) {
        ;[users.value, stats.value, adminDevices.value, adminLogs.value] = await Promise.all([
          request<Account[]>('/api/admin/users'),
          request<OverviewStats>('/api/admin/overview'),
          request<Device[]>('/api/admin/devices'),
          request<AuditLog[]>('/api/admin/audit-logs'),
        ])
      }
    } catch (error: unknown) {
      reportError(error)
    }
  }
  /** 处理注册与登录；首次管理员登录只能进入修改临时密码流程。 */
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
  /** 校验两次输入后修改密码；后端撤销旧 Session，再引导重新登录。 */
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

  /** 注销当前 Session 并恢复访客页面。 */
  async function logout() {
    await request('/api/auth/logout', 'POST')
    me.value = null
    page.value = 'overview'
  }
  /** 修改设备显示名称，操作失败不改变页面状态。 */
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
  /** 用户主动撤销自己的设备凭据。 */
  async function revoke(d: Device) {
    try {
      await ElMessageBox.confirm(
        `解绑后 ${d.name} 将立刻无法访问本平台，需重新配对。`,
        '确认解绑',
        {
          type: 'warning',
          confirmButtonText: '解绑设备',
        },
      )
      await request(`/api/me/devices/${d.id}`, 'DELETE')
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }
  /** 确认 Runtime 设备配对码，绑定当前平台账号。 */
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
  /** 主动撤销 OAuth 客户端授权。 */
  async function revokeGrant(g: OAuthGrant) {
    try {
      await ElMessageBox.confirm(
        '撤销后，相关 AI 客户端需要重新授权才能调用 MCP 工具。',
        '撤销 AI 连接',
        { type: 'warning' },
      )
      await request('/api/me/oauth-grants/' + encodeURIComponent(g.clientId), 'DELETE')
      await refresh()
      ElMessage.success('授权已撤销')
    } catch (error: unknown) {
      reportError(error)
    }
  }
  /** 在云端撤销工作区启用状态；Runtime 重连不得自动恢复。 */
  async function disableWorkspace(w: Workspace) {
    try {
      await ElMessageBox.confirm('停用后，AI 无法继续访问该工作区。', '停用工作区', {
        type: 'warning',
      })
      await request('/api/me/workspaces/' + w.id, 'PATCH', { enabled: false })
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }
  /** 管理员撤销设备并要求重新配对。 */
  async function adminRevoke(d: Device) {
    try {
      await ElMessageBox.confirm('撤销后设备必须重新绑定。', '管理员撤销设备', { type: 'warning' })
      await request('/api/admin/devices/' + d.id + '/revoke', 'POST')
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }
  /** 管理员控制普通用户账户状态。 */
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
  /** 切换 Console 内部页面，并保持 URL 与当前视图一致。 */
  function navigate(p: string) {
    page.value = p
    history.replaceState(null, '', p.startsWith('admin-') ? '/admin' : '/console')
  }
  /** 复制 MCP Server URL 供 AI 客户端连接。 */
  function copyUrl() {
    navigator.clipboard.writeText((import.meta.env.VITE_API_URL || location.origin) + '/mcp')
    ElMessage.success('MCP URL 已复制')
  }
  onMounted(() => {
    if (location.pathname === '/activate') page.value = 'activate'
    load()
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

  /** 向 Vue 页面公开响应式状态和事件处理器，页面本身不承载接口逻辑。 */
  return {
    me,
    loading,
    page,
    email,
    password,
    registering,
    devices,
    workspaces,
    users,
    logs,
    adminDevices,
    adminLogs,
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
    disableWorkspace,
    adminRevoke,
    setUserStatus,
    navigate,
    copyUrl,
  }
}
