import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

/** 取消弹窗属于正常交互；其他错误向用户显示，避免默默失败。 */
const reportError = (error: unknown) => {
  if (error === 'cancel' || error === 'close') return
  ElMessage.error(error instanceof Error ? error.message : '操作失败')
}

import { requestLocal } from './http'
import { subscribeLocalEvents, type LocalEventName } from './local-events'

interface ServerView {
  id: string
  name: string
  gateway: string
  deviceId?: string
  paired: boolean
  paused: boolean
  workspaceCount: number
}
/** 每个服务器的独立配对摘要，响应中不包含设备 Token。 */
interface RuntimeStatus {
  runtimeVersion: string
  online: boolean
  paired: boolean
  deviceId?: string
  gateway: string
  name: string
  serverId: string
  serverName: string
  paused: boolean
  connectionError?: string
  servers: ServerView[]
}

/** 只在 Runtime 本地保存的命令配置。 */
interface CommandView {
  id: string
  name: string
  executable: string
  args: string[]
}

/** 本地页面的工作区视图，root 不会被同步到云端。 */
interface WorkspaceView {
  serverId: string
  authorized: boolean
  /** 写入策略仅属于本机设置，不同步给云端 Gateway。 */
  writePolicy: 'auto' | 'approval'
  commands?: CommandView[]
  id: string
  name: string
  root: string
  enabled: boolean
  permissions: { read: boolean; write: boolean }
}

/** 仅用于在本机选择授权目录的目录浏览数据。 */
interface DirectoryBrowser {
  path: string
  parent: string
  entries: Array<{ name: string; path: string }>
}

/** 十分钟有效的一次性设备配对申请。 */
interface PairingRequest {
  serverId: string
  id: string
  code: string
  privateSecret: string
  activationUrl: string
  expiresIn: number
}

/** 用户批准写文件时展示的摘要，完整内容保存在服务端审批队列中。 */
interface WriteApprovalView {
  id: string
  operation: string
  workspaceName: string
  path: string
  bytes: number
  preview: string
  truncated: boolean
  createdAt: number
}

/**
 * Runtime 本地管理视图的数据模型。
 * HTTP 统一由 Axios 封装，认证 Token 仅供同源本地接口使用。
 */
export function useRuntimeConsole() {
  const browserWindow = window
  const token = ref(sessionStorage.getItem('rcm_key') || ''),
    status = ref<RuntimeStatus>({
      runtimeVersion: '',
      online: false,
      paired: false,
      gateway: '',
      name: '',
      serverId: '',
      serverName: '',
      paused: false,
      servers: [],
    }),
    workspaces = ref<WorkspaceView[]>([]),
    writeApprovals = ref<WriteApprovalView[]>([]),
    showAddServer = ref(false),
    serverName = ref(''),
    serverGateway = ref(''),
    serverBusy = ref(false),
    folder = ref(''),
    folderName = ref(''),
    showAdd = ref(false),
    browse = ref<DirectoryBrowser | null>(null),
    pairing = ref<PairingRequest | null>(null),
    code = ref(''),
    commandWorkspace = ref<WorkspaceView | null>(null),
    commandId = ref(''),
    commandName = ref(''),
    commandExecutable = ref(''),
    commandArgs = ref('[]')
  let unsubscribeEvents: (() => void) | undefined
  function applyStatus(next: RuntimeStatus) {
    if (status.value.serverId !== next.serverId) {
      workspaces.value = []
      writeApprovals.value = []
      pairing.value = null
      commandWorkspace.value = null
      showAdd.value = false
    }
    status.value = next
  }
  if (location.hash.includes('token=')) {
    const t = new URLSearchParams(location.hash.slice(1)).get('token')
    if (t) {
      token.value = t
      sessionStorage.setItem('rcm_key', t)
      history.replaceState(null, '', location.pathname)
    }
  }
  /** 将本地管理请求统一交给 Axios，Token 仅在请求时注入。 */
  const api = <T = unknown>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
    data?: unknown,
  ) => requestLocal<T>(path, token.value, method, data)

  /** 轻量更新设备连接状态；不读取工作区，也不覆盖用户正在编辑的 Gateway URL。 */
  async function refreshStatus() {
    if (!token.value) return
    const next = await api<RuntimeStatus>('status')
    applyStatus(next)
    // 设备离线时不会收到写入请求，清空已结束连接的审批显示。
    if (!next.online) writeApprovals.value = []
  }

  /** 仅在设备在线时轮询待审批写入，保障 30 秒审批时限内可见。 */
  async function refreshApprovals() {
    if (!token.value || !status.value.online) return
    writeApprovals.value = await api<WriteApprovalView[]>('write-approvals')
  }

  /** 读取工作区授权；不会因设备状态定时轮询而重复获取。 */
  async function refreshWorkspaces() {
    if (!token.value) return
    const serverId = status.value.serverId
    const next = await api<WorkspaceView[]>('workspaces')
    if (status.value.serverId === serverId) workspaces.value = next
  }

  /** 用户手动刷新及本地配置变更后完整刷新三个独立视图。 */
  async function refresh() {
    if (!token.value) return
    try {
      await refreshStatus()
      await Promise.all([refreshWorkspaces(), refreshApprovals()])
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 处理 SSE 推送的三个本地视图快照，不修改正在编辑的 Gateway 草稿。 */
  function applyEvent(name: LocalEventName, payload: unknown) {
    if (name === 'status') {
      const next = payload as RuntimeStatus
      applyStatus(next)
    } else if (name === 'workspaces') {
      workspaces.value = payload as WorkspaceView[]
    } else if (name === 'write-approvals') {
      writeApprovals.value = payload as WriteApprovalView[]
    }
  }
  /** 要求用户明确确认一次文件写入请求，提交同意或拒绝结果。 */
  async function answerWriteApproval(id: string, approve: boolean) {
    try {
      if (approve) {
        const item = writeApprovals.value.find((x) => x.id === id)
        const sensitive = item?.operation === 'file.delete' || item?.operation === 'command.run'
        await ElMessageBox.confirm(
          sensitive
            ? '这项操作可能删除文件或执行项目代码，且无法保证撤销。请核对工作区、路径和命令后再批准。'
            : '批准后，当前远程请求将修改授权工作区中的文件。只批准你明确认识的请求。',
          sensitive ? '确认高风险本地操作' : '确认本地文件操作',
          { type: 'warning', confirmButtonText: sensitive ? '批准执行' : '允许修改' },
        )
      }
      await api('write-approvals/' + encodeURIComponent(id), 'POST', { approve })
      await refresh()
      ElMessage.success(approve ? '已批准本次操作' : '已拒绝本次操作')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  async function manageServer(action: () => Promise<unknown>, message: string) {
    if (serverBusy.value) return
    serverBusy.value = true
    try {
      await action()
      await refresh()
      ElMessage.success(message)
    } catch (error: unknown) {
      reportError(error)
    } finally {
      serverBusy.value = false
    }
  }
  async function addServer() {
    await manageServer(async () => {
      const server = await api<{ id: string }>('servers', 'POST', {
        name: serverName.value,
        gateway: serverGateway.value,
      })
      await api('servers/' + server.id + '/activate', 'POST')
      showAddServer.value = false
      serverName.value = ''
      serverGateway.value = ''
    }, '服务器已保存并切换；已有绑定会自动恢复')
  }
  async function activateServer(server: ServerView) {
    await manageServer(
      () => api('servers/' + server.id + '/activate', 'POST'),
      '已切换到 ' + server.name,
    )
  }
  async function renameServer(server: ServerView) {
    try {
      const { value } = await ElMessageBox.prompt('服务器显示名称', '重命名服务器', {
        inputValue: server.name,
        inputValidator: (name) => !!name.trim(),
      })
      await manageServer(() => api('servers/' + server.id, 'PATCH', { name: value }), '名称已更新')
    } catch (error: unknown) {
      reportError(error)
    }
  }
  async function removeServer(server: ServerView) {
    try {
      await ElMessageBox.confirm(
        server.paired
          ? `移除 ${server.name} 前会先向该服务器撤销设备绑定；无法连接时会保留配置。`
          : `确认移除 ${server.name}？`,
        '移除服务器',
        { type: 'warning', confirmButtonText: '移除服务器' },
      )
      await manageServer(() => api('servers/' + server.id, 'DELETE'), '服务器配置已移除')
    } catch (error: unknown) {
      reportError(error)
    }
  }
  async function toggleConnection() {
    const current = status.value
    await manageServer(
      () => api('servers/' + current.serverId, 'PATCH', { paused: !current.paused }),
      current.paused ? '正在恢复连接' : '连接已暂停，配对配置已保留',
    )
  }
  async function startPair() {
    const serverId = status.value.serverId
    await manageServer(async () => {
      const result = await api<PairingRequest>('pair/start', 'POST', { serverId })
      if (status.value.serverId === result.serverId) pairing.value = result
    }, '配对码已生成，请在对应服务器完成确认')
  }
  async function finishPair() {
    const pending = pairing.value
    if (!pending) return
    await manageServer(async () => {
      const result = await api<{ status: string }>('pair/complete', 'POST', {
        serverId: pending.serverId,
        id: pending.id,
        privateSecret: pending.privateSecret,
      })
      if (result.status !== 'complete') throw Error('请先在对应平台确认配对码')
      if (pairing.value?.id === pending.id) pairing.value = null
    }, '设备绑定成功，凭据已按服务器保存')
  }
  async function toggleWorkspaceAuthorization(workspace: WorkspaceView) {
    try {
      await ElMessageBox.confirm(
        workspace.authorized
          ? `停止向当前服务器开放 ${workspace.name}？其他服务器的权限保持不变。`
          : `允许当前服务器只读访问 ${workspace.name}？`,
        workspace.authorized ? '取消工作区授权' : '授权工作区',
        { type: 'warning' },
      )
      await api('workspaces/' + workspace.id, 'PATCH', {
        serverId: workspace.serverId,
        authorized: !workspace.authorized,
      })
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }
  /** 读取本地目录供用户选择工作区，不向云端暴露绝对路径。 */
  async function openBrowse(p?: string) {
    try {
      browse.value = await api<DirectoryBrowser>(
        'browse' + (p ? '?path=' + encodeURIComponent(p) : ''),
      )
    } catch (error: unknown) {
      reportError(error)
    }
  }
  /** 选择当前浏览目录作为待授权根路径。 */
  function pickDir() {
    if (!browse.value) return
    folder.value = browse.value.path
    browse.value = null
  }
  /** 添加工作区授权，默认只有读权限。 */
  async function addWorkspace() {
    try {
      await api('workspaces', 'POST', {
        serverId: status.value.serverId,
        root: folder.value,
        name: folderName.value,
      })
      showAdd.value = false
      folder.value = ''
      folderName.value = ''
      await refresh()
      ElMessage.success('工作区授权成功')
    } catch (error: unknown) {
      reportError(error)
    }
  }
  /** 通过二次确认切换工作区写入权限。 */
  async function toggleWrite(w: WorkspaceView) {
    try {
      if (!w.permissions.write)
        await ElMessageBox.confirm(
          '允许 AI 修改这个项目的文件？仅对你明确授权的工作区开放。',
          '开启写入权限',
          { type: 'warning' },
        )
      await api('workspaces/' + w.id, 'PATCH', {
        serverId: w.serverId,
        write: !w.permissions.write,
      })
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }
  /** 每个工作区独立选择写入模式；自动写入必须经过显式风险确认。 */
  async function changeWritePolicy(w: WorkspaceView, policy: 'auto' | 'approval') {
    if (policy === (w.writePolicy || 'approval')) return
    try {
      if (!w.enabled || !w.permissions.write) throw Error('请先开启该工作区写入权限')
      if (policy === 'auto') {
        await ElMessageBox.confirm(
          '自动写入模式下，AI 可以在授权工作区内连续修改文件，无需每次确认。仍会校验文件路径、敏感文件及版本冲突。确定开启吗？',
          '开启自动写入',
          { type: 'warning', confirmButtonText: '确认自动写入', distinguishCancelAndClose: true },
        )
      }
      await api('workspaces/' + w.id, 'PATCH', { serverId: w.serverId, writePolicy: policy })
      await refresh()
      ElMessage.success(policy === 'auto' ? '已开启自动写入' : '已切换为逐次审批')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 编辑工作区下的本地命令白名单：远程 AI 不可修改 executable 或 args。 */
  function showCommandForm(w: WorkspaceView) {
    commandWorkspace.value = w
    commandId.value = ''
    commandName.value = ''
    commandExecutable.value = ''
    commandArgs.value = '[]'
  }

  async function addCommand() {
    const workspace = commandWorkspace.value
    if (!workspace) return
    try {
      const args: unknown = JSON.parse(commandArgs.value)
      if (!Array.isArray(args) || !args.every((item) => typeof item === 'string'))
        throw Error('参数必须是 JSON 字符串数组，例如 ["run", "lint"]')
      await api('workspaces/' + workspace.id + '/commands', 'POST', {
        id: commandId.value,
        name: commandName.value,
        executable: commandExecutable.value,
        args,
      })
      commandWorkspace.value = null
      await refresh()
      ElMessage.success('本地命令已添加')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  async function deleteCommand(w: WorkspaceView, command: CommandView) {
    try {
      await ElMessageBox.confirm(
        '确认移除 ' + command.name + '？这会使尚未完成的审批请求失效。',
        '移除本地命令',
        { type: 'warning' },
      )
      await api('workspaces/' + w.id + '/commands/' + encodeURIComponent(command.id), 'DELETE')
      await refresh()
      ElMessage.success('本地命令已移除')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 确认后删除本地工作区授权并同步云端。 */
  async function remove(w: WorkspaceView) {
    try {
      await ElMessageBox.confirm(
        '确认从本机目录清单及所有服务器授权中移除 ' + w.name + '？本地文件会保留。',
        '移除工作区',
        {
          type: 'warning',
        },
      )
      await api('workspaces/' + w.id, 'DELETE')
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }
  async function unpair() {
    const serverId = status.value.serverId
    try {
      await ElMessageBox.confirm(
        `确认解除 ${status.value.serverName} 的设备绑定？服务器中的设备将被撤销，之后需要重新配对。暂停连接或切换服务器无需解除绑定。`,
        '解除设备绑定',
        { type: 'warning', confirmButtonText: '解除绑定' },
      )
      await manageServer(() => api('unpair', 'POST', { serverId }), '设备绑定已在服务器撤销')
    } catch (error: unknown) {
      reportError(error)
    }
  }
  onMounted(() => {
    if (!token.value) return
    // SSE 首次连接即推送状态、工作区和审批快照，无需重复 HTTP 轮询。
    unsubscribeEvents = subscribeLocalEvents(token.value, applyEvent, (error) =>
      console.warn('Runtime 本地事件流中断，正在重连', error),
    )
  })
  onUnmounted(() => {
    unsubscribeEvents?.()
  })
  /** 页面模板可访问的响应式状态与动作。 */
  return {
    browserWindow,
    token,
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
    changeWritePolicy,
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
