/** 本机待审批视图；预览与路径仅在 Runtime 本地页面短暂使用。 */
export interface WriteApprovalView {
  id: string
  operation: string
  workspaceId: string
  workspaceName: string
  path: string
  bytes: number
  preview: string
  truncated: boolean
  itemCount: number
  riskLevel: 'normal' | 'high'
  createdAt: number
  expiresAt: number
}

/** Gateway 配置的本地展示摘要，不包含设备凭据。 */
export interface ServerView {
  id: string
  name: string
  gateway: string
  deviceId?: string
  paired: boolean
  paused: boolean
  workspaceCount: number
}
export interface RuntimeStatus {
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
/** 短时配对申请中的私钥仅用于本机完成配对。 */
export interface PairingRequest {
  serverId: string
  id: string
  code: string
  privateSecret: string
  activationUrl: string
  expiresIn: number
}

/** Runtime 本地登记的固定命令；executable 与 args 不会同步给云端。 */
export interface CommandView {
  id: string
  name: string
  executable: string
  args: string[]
}
/** 本地工作区视图包含 root 绝对路径，仅供 Runtime 页面使用，不进入 Gateway 同步模型。 */
export interface WorkspaceView {
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
export interface DirectoryBrowser {
  path: string
  parent: string
  entries: Array<{ name: string; path: string }>
}
