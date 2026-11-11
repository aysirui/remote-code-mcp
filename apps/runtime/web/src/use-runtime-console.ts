import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

/** 取消弹窗属于正常交互；其他错误向用户显示，避免默默失败。 */
const reportError = (error: unknown) => {
  if (error === 'cancel' || error === 'close') return
  ElMessage.error(error instanceof Error ? error.message : '操作失败')
}

import { requestLocal } from './http'
import { subscribeLocalEvents, type LocalEventName } from './local-events'

/** 当前已配置 Gateway 的本地摘要；不包含设备 Token 或授权密钥。 */
interface ServerView {
  id: string
  name: string
  gateway: string
  deviceId?: string
  paired: boolean
  paused: boolean
  workspaceCount: number
}
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
/** Runtime 本地登记的固定命令；executable 与 args 不会同步给云端。 */
interface CommandView {
  id: string
  name: string
  executable: string
  args: string[]
}
/** 本地工作区视图包含 root 绝对路径，仅供 Runtime 页面使用，不进入 Gateway 同步模型。 */
interface WorkspaceView {
  serverId: string
  authorized: boolean
  policies: {
    file: 'deny' | 'approval' | 'allow'
    git: 'deny' | 'approval' | 'allow'
    command: 'deny' | 'approval' | 'allow'
  }
  commands?: CommandView[]
  id: string
  name: string
  root: string
  enabled: boolean
  permissions: { read: boolean; write: boolean }
}
/** 本机目录选择器的数据；path 只在本地管理 API 和页面间流转。 */
interface DirectoryBrowser {
  path: string
  parent: string
  entries: Array<{ name: string; path: string }>
}
/** 短时有效的一次性设备配对申请；privateSecret 仅供本机完成配对。 */
interface PairingRequest {
  serverId: string
  id: string
  code: string
  privateSecret: string
  activationUrl: string
  expiresIn: number
}

/** 本机待审批视图包含工作区名称和 ID；文件路径、预览等详情仅在 Runtime 内存中短暂存在。 */
interface WriteApprovalView {
  id: string
  operation: string
  workspaceId: string
  workspaceName: string
  path: string
  bytes: number
  preview: string
  truncated: boolean
  createdAt: number
}

/** Runtime 本地管理视图的数据模型。 */
export function useRuntimeConsole() {
  const browserWindow = window
  const token = ref(sessionStorage.getItem('rcm_key') || '')
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
  const showAddServer = ref(false)
  const serverName = ref('')
  const serverGateway = ref('')
  const serverBusy = ref(false)
  const folder = ref('')
  const folderName = ref('')
  const showAdd = ref(false)
  const browse = ref<DirectoryBrowser | null>(null)
  const pairing = ref<PairingRequest | null>(null)
  const code = ref('')
  const commandWorkspace = ref<WorkspaceView | null>(null)
  const commandId = ref('')
  const commandName = ref('')
  const commandExecutable = ref('')
  const commandArgs = ref('[]')
  let unsubscribeEvents: (() => void) | undefined

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
  }

  if (location.hash.includes('token=')) {
    const t = new URLSearchParams(location.hash.slice(1)).get('token')
    if (t) {
      token.value = t
      sessionStorage.setItem('rcm_key', t)
      history.replaceState(null, '', location.pathname)
    }
  }

  const api = <T = unknown>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
    data?: unknown,
  ) => requestLocal<T>(path, token.value, method, data)

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

  /** 提交本机用户对单次请求的批准或拒绝；高风险操作再次展示明确确认信息。 */
  async function answerWriteApproval(id: string, approve: boolean) {
    try {
      if (approve) {
        const item = writeApprovals.value.find((x) => x.id === id)
        const operation = item?.operation
        const sensitive = ['file.delete', 'command.run', 'git.add', 'git.commit'].includes(
          operation || '',
        )
        const message =
          operation === 'command.run'
            ? '将执行本地预先登记的命令，可能修改项目或访问本机资源。请确认命令和工作区后再批准。'
            : operation === 'file.delete'
              ? '这项操作可能删除文件或目录，且无法保证撤销。请核对路径后再批准。'
              : operation === 'git.add'
                ? '将把列出的普通文件加入 Git 暂存区。请核对文件路径和内容是否符合预期。'
                : operation === 'git.commit'
                  ? '将提交当前暂存区中的全部变更。请核对暂存文件列表和提交说明。'
                  : ['file.write', 'file.mkdir', 'file.move'].includes(operation || '')
                    ? '批准后，当前远程请求将修改授权工作区中的文件。只批准你明确认识的请求。'
                    : '此请求会读取本地文件或 Git 信息，并将结果返回 AI 客户端。请确认是否允许读取。'
        await ElMessageBox.confirm(message, sensitive ? '确认高风险本地操作' : '确认本地操作', {
          type: 'warning',
          confirmButtonText: sensitive ? '批准执行' : '允许本次操作',
        })
      }
      await api('write-approvals/' + encodeURIComponent(id), 'POST', { approve })
      await refresh()
      ElMessage.success(approve ? '已批准本次操作' : '已拒绝本次操作')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 串行执行服务器配置变更，避免连续点击造成并发写入或连接切换竞态。 */
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

  /** 添加新的 Gateway 配置；重复地址由状态层保留原有设备凭据。 */
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

  /** 切换当前活动服务器，并由 Runtime 统一处理断开、审批取消和重连。 */
  async function activateServer(server: ServerView) {
    await manageServer(
      () => api('servers/' + server.id + '/activate', 'POST'),
      '已切换到 ' + server.name,
    )
  }

  /** 修改服务器本地显示名称，不改变 Gateway 地址或设备身份。 */
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

  /** 经确认移除服务器配置；已配对服务器需先处理设备绑定状态。 */
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

  /** 暂停或恢复当前服务器连接；暂停时取消所有待处理审批。 */
  async function toggleConnection() {
    const current = status.value
    await manageServer(
      () => api('servers/' + current.serverId, 'PATCH', { paused: !current.paused }),
      current.paused ? '正在恢复连接' : '连接已暂停，配对配置已保留',
    )
  }

  /** 向当前 Gateway 申请一次性设备配对码，配对密钥只在本机短暂展示。 */
  async function startPair() {
    const serverId = status.value.serverId
    await manageServer(async () => {
      const result = await api<PairingRequest>('pair/start', 'POST', { serverId })
      if (status.value.serverId === result.serverId) pairing.value = result
    }, '配对码已生成，请在对应服务器完成确认')
  }

  /** 使用用户在云端确认的配对结果完成设备绑定并保存本机凭据。 */
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

  /** 独立切换当前服务器对本地工作区的授权，不影响其他服务器的授权记录。 */
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

  /** 在 Runtime 本机浏览目录；绝对路径只返回本地页面，不同步到 Gateway。 */
  async function openBrowse(p?: string) {
    try {
      browse.value = await api<DirectoryBrowser>(
        'browse' + (p ? '?path=' + encodeURIComponent(p) : ''),
      )
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 将当前浏览位置设为待授权工作区根目录。 */
  function pickDir() {
    if (!browse.value) return
    folder.value = browse.value.path
    browse.value = null
  }

  /** 将用户选择的本地目录登记为工作区，初始权限遵循只读默认策略。 */
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

  /** 修改工作区读写开关；扩大写权限前要求用户明确确认。 */
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

  /** 修改本地 File/Git/Command 策略；allow 会展示风险说明并要求再次确认。 */
  async function changePolicy(
    w: WorkspaceView,
    domain: 'file' | 'git' | 'command',
    policy: 'deny' | 'approval' | 'allow',
  ) {
    if (policy === w.policies[domain]) return
    try {
      if (policy === 'allow') {
        const description =
          domain === 'command'
            ? '已登记命令将在不逐次确认的情况下执行。命令仍受本地固定命令注册表及 Hard Deny 限制。'
            : domain === 'file'
              ? '文件工具将在不逐次确认的情况下执行；工作区读写开关及路径 Hard Deny 仍然生效。'
              : 'Git 工具将在不逐次确认的情况下执行；Git 固定子命令及环境隔离仍然生效。'
        await ElMessageBox.confirm(description, '确认设为完全允许', {
          type: 'warning',
          confirmButtonText: '确认允许',
        })
      }
      await api('workspaces/' + w.id, 'PATCH', {
        serverId: w.serverId,
        policies: { [domain]: policy },
      })
      await refresh()
      ElMessage.success(domain + ' 权限策略已更新')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 打开当前工作区的本地命令登记表单，远程 AI 无法编辑命令定义。 */
  function showCommandForm(w: WorkspaceView) {
    commandWorkspace.value = w
    commandId.value = ''
    commandName.value = ''
    commandExecutable.value = ''
    commandArgs.value = '[]'
  }

  /** 保存本地固定命令定义；入参由 Runtime 校验，远程只能引用命令 ID。 */
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

  /** 删除本地命令登记项；审批中的命令会在执行前重新校验指纹。 */
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

  /** 移除本地工作区登记及其服务器授权，并取消该工作区的待审批任务。 */
  async function remove(w: WorkspaceView) {
    try {
      await ElMessageBox.confirm(
        '确认从本机目录清单及所有服务器授权中移除 ' + w.name + '？本地文件会保留。',
        '移除工作区',
        { type: 'warning' },
      )
      await api('workspaces/' + w.id, 'DELETE')
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 解除当前服务器的设备配对，清除本机凭据并终止当前连接。 */
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

  // SSE 首次连接会推送状态、工作区和审批快照；不再额外启动重复轮询。
  onMounted(() => {
    if (!token.value) return
    unsubscribeEvents = subscribeLocalEvents(token.value, applyEvent, (error) =>
      console.warn('Runtime 本地事件流中断，正在重连', error),
    )
  })
  onUnmounted(() => {
    unsubscribeEvents?.()
  })

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
