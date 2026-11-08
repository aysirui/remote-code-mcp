import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { WorkspacePublic } from '@rcm/protocol'
/** 本地工作区模型：公开授权信息 + 仅保存在本机的根路径。 */
export type LocalWorkspace = WorkspacePublic & { root: string }
/** Runtime 持久化配置；设备 Token 不得上传到云端日志或界面。 */
export type Config = {
  gateway: string
  deviceId?: string
  deviceToken?: string
  name: string
  workspaces: LocalWorkspace[]
}
/** Runtime 配置存储位置，默认是当前用户私有目录。 */
export const dataDir = process.env.RUNTIME_DATA_DIR || path.join(os.homedir(), '.remote-code-mcp')
const file = path.join(dataDir, 'config.json')
/** 读取本地配置；首次运行时返回安全的默认配置。 */
export async function load(): Promise<Config> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    return {
      gateway: process.env.GATEWAY_URL || 'http://localhost:3000',
      name: os.hostname(),
      workspaces: [],
    }
  }
}
/** 通过临时文件与重命名保存配置，Unix 平台限制文件权限为 0600。 */
export async function save(cfg: Config) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dataDir, '.tmp-' + randomUUID())
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  await fs.rename(tmp, file)
  if (process.platform !== 'win32') await fs.chmod(file, 0o600)
}
/** 只同步工作区公开信息到 Gateway，绝不包含 root 绝对路径。 */
export const publicWs = (w: LocalWorkspace): WorkspacePublic => ({
  id: w.id,
  name: w.name,
  permissions: w.permissions,
  enabled: w.enabled,
})
