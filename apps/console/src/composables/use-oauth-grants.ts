import { ElMessage, ElMessageBox } from 'element-plus'
import { request, type OAuthGrant } from '../api'

/** AI 客户端授权管理：仅撤销用户明确选择的客户端授权。 */
export function useOAuthGrants(
  refresh: () => Promise<void>,
  reportError: (error: unknown) => void,
) {
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

  return { revokeGrant }
}
