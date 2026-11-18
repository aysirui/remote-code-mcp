import { ref, type Ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { RuntimeStatus, ServerView, PairingRequest } from '../types/runtime'

/** 当前服务器的配置、连接状态和设备配对操作。 */
export function useServers(
  status: Ref<RuntimeStatus>,
  pairing: Ref<PairingRequest | null>,
  api: <T = unknown>(
    path: string,
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    data?: unknown,
  ) => Promise<T>,
  refresh: () => Promise<void>,
  reportError: (error: unknown) => void,
) {
  const showAddServer = ref(false)
  const serverName = ref('')
  const serverGateway = ref('')
  const serverBusy = ref(false)
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

  /** 添加新的 Server 配置；重复地址由状态层保留原有设备凭据。 */
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

  /** 修改服务器本地显示名称，不改变 Server 地址或设备身份。 */
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
        { type: 'warning', confirmButtonText: '移除服务器', confirmButtonType: 'danger' },
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

  /** 向当前 Server 申请一次性设备配对码，配对密钥只在本机短暂展示。 */
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

  return {
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
  }
}
