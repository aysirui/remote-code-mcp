import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { request, type Device } from '../api'

/** 当前用户的设备管理及一次性配对操作，独立于 Console 根状态。 */
export function useDevices(refresh: () => Promise<void>, reportError: (error: unknown) => void) {
  const pairingCode = ref('')
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

  return { pairingCode, rename, revoke, approve }
}
