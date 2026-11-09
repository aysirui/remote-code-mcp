import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

/** 取消弹窗属于正常交互；其他错误向用户显示，避免默默失败。 */
const reportError = (error: unknown) => {
  if (error === 'cancel' || error === 'close') return
  ElMessage.error(error instanceof Error ? error.message : '操作失败')
}

import { requestLocal } from './http'
import { subscribeLocalEvents, type LocalEventName } from './local-events'

/** Runtime 与云端的连接状态，设备 Token 故意不包含在响应中。 */
interface RuntimeStatus {
  online: boolean
  paired: boolean
  deviceId?: string
  gateway: string
  name: string
}

/** 本地页面的工作区视图，root 不会被同步到云端。 */
interface WorkspaceView {
  /** 写入策略仅属于本机设置，不同步给云端 Gateway。 */
  writePolicy: 'auto' | 'approval'
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
  id: string
  code: string
  privateSecret: string
  activationUrl: string
  expiresIn: number
}

/** 用户批准写文件时展示的摘要，完整内容保存在服务端审批队列中。 */
interface WriteApprovalView {
  id: string
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
    status = ref<RuntimeStatus>({ online: false, paired: false, gateway: '', name: '' }),
    workspaces = ref<WorkspaceView[]>([]),
    writeApprovals = ref<WriteApprovalView[]>([]),
    gateway = ref(''),
    folder = ref(''),
    folderName = ref(''),
    showAdd = ref(false),
    browse = ref<DirectoryBrowser | null>(null),
    pairing = ref<PairingRequest | null>(null),
    code = ref('')
  let unsubscribeEvents: (() => void) | undefined
  /** 用户修改 Gateway 地址后保持草稿，定时状态更新不得覆盖输入。 */
  const gatewayDirty = ref(false)
  function setGatewayDraft(value: string) {
    gateway.value = value
    gatewayDirty.value = true
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
    status.value = next
    if (!gatewayDirty.value) gateway.value = next.gateway
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
    workspaces.value = await api<WorkspaceView[]>('workspaces')
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
      status.value = next
      if (!gatewayDirty.value) gateway.value = next.gateway
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
        await ElMessageBox.confirm(
          '批准后，当前远程请求将修改所列文件。只批准你明确认识的请求。',
          '确认本地文件写入',
          { type: 'warning', confirmButtonText: '允许写入' },
        )
      }
      await api('write-approvals/' + encodeURIComponent(id), 'POST', { approve })
      await refresh()
      ElMessage.success(approve ? '已批准本次写入' : '已拒绝本次写入')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 切换 Gateway 地址会解除现有设备绑定，必须先让用户确认。 */
  async function updateGateway() {
    try {
      await ElMessageBox.confirm('更换服务地址会解绑当前设备，确定继续吗？', '切换 Gateway', {
        type: 'warning',
      })
      await api('config', 'POST', { gateway: gateway.value })
      // 配置保存成功后，允许状态刷新重新同步服务端的规范化地址。
      gatewayDirty.value = false
      await refresh()
      ElMessage.success('服务地址已更新')
    } catch (error: unknown) {
      reportError(error)
    }
  }
  /** 向 Gateway 请求一次性设备配对码。 */
  async function startPair() {
    try {
      pairing.value = await api<PairingRequest>('pair/start', 'POST')
      ElMessage.success('配对码已生成')
    } catch (error: unknown) {
      reportError(error)
    }
  }
  /** 轮询并领取当前配对的设备凭据；成功后刷新本地状态。 */
  async function finishPair() {
    if (!pairing.value) return
    try {
      const r = await api<{ status: string }>('pair/complete', 'POST', {
        id: pairing.value.id,
        privateSecret: pairing.value.privateSecret,
      })
      if (r.status === 'complete') {
        pairing.value = null
        ElMessage.success('设备绑定成功')
        await refresh()
      } else ElMessage.info('请先在平台输入配对码并确认绑定')
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
      await api('workspaces', 'POST', { root: folder.value, name: folderName.value })
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
      await api('workspaces/' + w.id, 'PATCH', { write: !w.permissions.write })
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
      await api('workspaces/' + w.id, 'PATCH', { writePolicy: policy })
      await refresh()
      ElMessage.success(policy === 'auto' ? '已开启自动写入' : '已切换为逐次审批')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 确认后删除本地工作区授权并同步云端。 */
  async function remove(w: WorkspaceView) {
    try {
      await ElMessageBox.confirm('确认移除 ' + w.name + ' 的授权？', '移除工作区', {
        type: 'warning',
      })
      await api('workspaces/' + w.id, 'DELETE')
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }
  /** 删除本地设备凭据并断开现有连接。 */
  async function unpair() {
    try {
      await ElMessageBox.confirm(
        '本地将停止连接，若想完全撤销云端设备凭据，请同时在 Web Console 解绑。',
        '断开设备',
      )
      await api('unpair', 'POST')
      await refresh()
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
    gateway,
    setGatewayDraft,
    folder,
    folderName,
    showAdd,
    browse,
    pairing,
    code,
    refresh,
    answerWriteApproval,
    updateGateway,
    startPair,
    finishPair,
    openBrowse,
    pickDir,
    addWorkspace,
    toggleWrite,
    changeWritePolicy,
    remove,
    unpair,
  }
}

/** 根组件提供给 Runtime 各路由页面的共享状态和操作。 */
export type RuntimeContext = ReturnType<typeof useRuntimeConsole>
