import { ElMessageBox } from 'element-plus'
import { request, type Device, type User as Account } from '../api'

/** 管理端设备与用户状态操作；权限判断始终由服务端执行。 */
export function useAdminActions(
  refresh: () => Promise<void>,
  reportError: (error: unknown) => void,
) {
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

  return { adminRevoke, setUserStatus }
}
