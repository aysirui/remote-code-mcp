import { useApprovalNotifications } from './use-approval-notifications'
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { LocalAuthorizationError } from '../local-auth'
import { useWriteApprovals } from './use-write-approvals'
import { useServers } from './use-servers'
import { useWorkspaces } from './use-workspaces'
import type {
  WriteApprovalView,
  RuntimeStatus,
  PairingRequest,
  WorkspaceView,
} from '../types/runtime'

/** 取消弹窗属于正常交互；其他错误向用户显示，避免默默失败。 */
const reportError = (error: unknown) => {
  if (error === 'cancel' || error === 'close') return
  if (error instanceof LocalAuthorizationError) return
  ElMessage.error(error instanceof Error ? error.message : '操作失败')
}

import { requestLocal } from '../api/http'
import type { LocalEventName } from '../api/local-events'
import { useRuntimeEvents } from './use-runtime-events'

/** Runtime 本地管理视图的数据模型。 */
export function useRuntimeConsole() {
  const browserWindow = window
  const token = ref(sessionStorage.getItem('rcm_key') || '')
  const authorizationExpired = ref(false)
  const status = ref<RuntimeStatus>({
    runtimeVersion: '',
    online: false,
    paired: false,
    gateway: '',
    name: '',
    serverId: '',
    serverName: '',
    paused: false,
    servers: [],
  })
  const workspaces = ref<WorkspaceView[]>([])
  const writeApprovals = ref<WriteApprovalView[]>([])
  const notifications = useApprovalNotifications(
    writeApprovals,
    computed(() => status.value.serverId),
    computed(() => Boolean(token.value) && status.value.online),
  )
  const pairing = ref<PairingRequest | null>(null)
  const code = ref('')

  /** 应用服务器连接快照；切换服务器时清除旧服务器的工作区和待审批详情。 */
  function applyStatus(next: RuntimeStatus) {
    if (status.value.serverId !== next.serverId) {
      workspaces.value = []
      writeApprovals.value = []
      pairing.value = null
      commandWorkspace.value = null
      showAdd.value = false
    }
    status.value = next
    if (!next.online) writeApprovals.value = []
  }

  /** 新启动链接可以在同一标签页恢复会话，不必再重启进程。 */
  function readTokenFromUrl() {
    const t = new URLSearchParams(location.hash.slice(1)).get('token')
    if (t) {
      token.value = t
      authorizationExpired.value = false
      sessionStorage.setItem('rcm_key', t)
      history.replaceState(null, '', location.pathname + location.search)
      return true
    }
    return false
  }
  readTokenFromUrl()

  /** 凭据失效后清除旧会话与过期数据，停止继续使用无效凭据请求。 */
  function invalidateLocalSession() {
    authorizationExpired.value = true
    token.value = ''
    sessionStorage.removeItem('rcm_key')
    stopEvents()
    status.value = { ...status.value, online: false }
    workspaces.value = []
    writeApprovals.value = []
    pairing.value = null
    commandWorkspace.value = null
    showAdd.value = false
    showAddServer.value = false
  }

  const api = async <T = unknown>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
    data?: unknown,
  ) => {
    const requestToken = token.value
    try {
      return await requestLocal<T>(path, requestToken, method, data)
    } catch (error) {
      // 丢弃旧会话迟到的 401，避免覆盖刚从新链接恢复的会话。
      if (error instanceof LocalAuthorizationError && token.value === requestToken)
        invalidateLocalSession()
      throw error
    }
  }

  /** 读取轻量连接状态；离线时立即清空已失效的审批展示。 */
  async function refreshStatus() {
    if (!token.value) return
    const next = await api<RuntimeStatus>('status')
    applyStatus(next)
    if (!next.online) writeApprovals.value = []
  }

  /** 仅在线时读取本机待审批队列，审批详情不会通过云端 API 获取。 */
  async function refreshApprovals() {
    if (!token.value || !status.value.online) return
    writeApprovals.value = await api<WriteApprovalView[]>('write-approvals')
  }

  /** 读取当前服务器对应的工作区视图，并丢弃切换服务器前发出的过期响应。 */
  async function refreshWorkspaces() {
    if (!token.value) return
    const serverId = status.value.serverId
    const next = await api<WorkspaceView[]>('workspaces')
    if (status.value.serverId === serverId) workspaces.value = next
  }

  /** 完整刷新本地状态、工作区和审批快照；单项加载失败统一反馈给用户。 */
  async function refresh() {
    if (!token.value) return
    try {
      await refreshStatus()
      await Promise.all([refreshWorkspaces(), refreshApprovals()])
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 处理本机 SSE 推送的状态快照，不覆盖用户正在编辑的表单草稿。 */
  function applyEvent(name: LocalEventName, payload: unknown) {
    if (name === 'status') {
      applyStatus(payload as RuntimeStatus)
    } else if (name === 'workspaces') {
      workspaces.value = payload as WorkspaceView[]
    } else if (name === 'write-approvals') {
      writeApprovals.value = payload as WriteApprovalView[]
    }
  }

  const { stopEvents } = useRuntimeEvents(
    browserWindow,
    token,
    applyEvent,
    invalidateLocalSession,
    readTokenFromUrl,
  )

  const { answerWriteApproval } = useWriteApprovals(writeApprovals, api, refresh, reportError)

  const {
    showAddServer,
    serverName,
    serverGateway,
    serverBusy,
    addServer,
    activateServer,
    renameServer,
    removeServer,
    toggleConnection,
    startPair,
    finishPair,
    manageServer,
  } = useServers(status, pairing, api, refresh, reportError)

  const {
    folder,
    folderName,
    showAdd,
    browse,
    commandWorkspace,
    commandId,
    commandName,
    commandExecutable,
    commandArgs,
    toggleWorkspaceAuthorization,
    openBrowse,
    pickDir,
    addWorkspace,
    toggleWrite,
    changePolicy,
    showCommandForm,
    addCommand,
    deleteCommand,
    remove,
  } = useWorkspaces(status, api, refresh, reportError)

  /** 解除当前服务器的设备配对，清除本机凭据并终止当前连接。 */
  async function unpair(localOnly = false) {
    const serverId = status.value.serverId
    try {
      await ElMessageBox.confirm(
        localOnly
          ? `确认仅清除 ${status.value.serverName} 在本机保存的设备凭据？适用于服务器数据库已重置、凭据失效或无法正常解绑的情况。此操作会断开连接，之后需要重新配对；如果服务器仍保留旧设备，请在平台中撤销该设备。`
          : `确认解除 ${status.value.serverName} 的设备绑定？服务器中的设备将被撤销，之后需要重新配对。暂停连接或切换服务器无需解除绑定。`,
        localOnly ? '仅清除本地绑定' : '解除设备绑定',
        {
          type: 'warning',
          confirmButtonText: localOnly ? '清除本地绑定' : '解除绑定',
          confirmButtonType: 'danger',
        },
      )
      await manageServer(
        () => api('unpair', 'POST', { serverId, localOnly }),
        localOnly ? '本地绑定已清除，可以重新配对' : '设备绑定已解除，可以重新配对',
      )
    } catch (error: unknown) {
      reportError(error)
    }
  }

  return {
    ...notifications,
    browserWindow,
    token,
    authorizationExpired,
    status,
    workspaces,
    writeApprovals,
    showAddServer,
    serverName,
    serverGateway,
    serverBusy,
    addServer,
    activateServer,
    renameServer,
    removeServer,
    toggleConnection,
    toggleWorkspaceAuthorization,
    folder,
    folderName,
    showAdd,
    browse,
    pairing,
    code,
    refresh,
    answerWriteApproval,
    startPair,
    finishPair,
    openBrowse,
    pickDir,
    addWorkspace,
    toggleWrite,
    changePolicy,
    commandWorkspace,
    commandId,
    commandName,
    commandExecutable,
    commandArgs,
    showCommandForm,
    addCommand,
    deleteCommand,
    remove,
    unpair,
  }
}

/** 根组件提供给 Runtime 各路由页面的共享状态和操作。 */
export type RuntimeContext = ReturnType<typeof useRuntimeConsole>
