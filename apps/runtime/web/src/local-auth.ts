/** 本地页面凭据只对一次 Runtime 启动有效，与远程设备绑定凭据无关。 */
export const LOCAL_AUTH_RECOVERY =
  '本地管理凭据已失效或与当前 Runtime 不匹配。请从当前 Runtime 启动终端重新打开完整的本地管理链接（包含 #token=）。如果找不到当前链接，请重启 Runtime，再使用新打印的链接打开页面；仅刷新旧页面无法恢复。'

export class LocalAuthorizationError extends Error {
  constructor() {
    super(LOCAL_AUTH_RECOVERY)
    this.name = 'LocalAuthorizationError'
  }
}
