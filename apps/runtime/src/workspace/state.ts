import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { WorkspacePublic, WorkspacePolicies, AccessPolicy } from '@rcm/protocol'

/** 仅由本地用户配置的固定可执行命令，不同步给云端设备元数据。 */
export interface LocalCommand {
  id: string
  name: string
  executable: string
  args: string[]
  /** 本机登记命令的最长运行时间（毫秒），不接受远程请求覆盖。 */
  timeoutMs?: number
}

/** 本机工作区模型包含 root 绝对路径；该字段仅供 Runtime 使用，禁止同步至 Gateway。 */
export type LocalWorkspace = WorkspacePublic & {
  root: string
  policies: WorkspacePolicies
  commands?: LocalCommand[]
}

/** 未知策略按 deny 处理，避免策略缺失时意外放行。 */
export const defaultWorkspacePolicies: WorkspacePolicies = {
  file: 'approval',
  git: 'allow',
  command: 'approval',
}
/** 归一化历史或损坏配置；未知策略按 deny 处理，避免配置缺失时意外放行。 */
export const normalizePolicies = (value?: Partial<WorkspacePolicies>): WorkspacePolicies => ({
  file:
    value?.file === 'deny' || value?.file === 'approval' || value?.file === 'allow'
      ? value.file
      : 'deny',
  git:
    value?.git === 'deny' || value?.git === 'approval' || value?.git === 'allow'
      ? value.git
      : 'deny',
  command:
    value?.command === 'deny' || value?.command === 'approval' || value?.command === 'allow'
      ? value.command
      : 'deny',
})
/** 根据操作前缀选择 File/Git/Command 策略；未知操作域保守归入 Command。 */
export const policyForOperation = (
  workspace: Pick<LocalWorkspace, 'policies'>,
  operation: string,
): AccessPolicy => {
  const domain = operation.startsWith('file.')
    ? 'file'
    : operation.startsWith('git.')
      ? 'git'
      : 'command'
  const value = workspace.policies?.[domain]
  return value === 'deny' || value === 'approval' || value === 'allow' ? value : 'deny'
}

/** 本地目录与命令只登记一次；权限保存在各服务器的授权中。 */
export interface WorkspaceDefinition {
  id: string
  name: string
  root: string
  commands?: LocalCommand[]
}
export type WorkspaceAuthorization = {
  workspaceId: string
  id: string
  authorized: boolean
  enabled: boolean
  permissions: { read: boolean; write: boolean }
  policies: WorkspacePolicies
}
export type ServerProfile = {
  id: string
  name: string
  gateway: string
  deviceId?: string
  deviceToken?: string
  paused: boolean
  workspaces: WorkspaceAuthorization[]
}
export type Config = {
  version: 2
  name: string
  activeServerId: string
  servers: ServerProfile[]
  workspaces: WorkspaceDefinition[]
}

/** 服务器身份按 origin 区分，拒绝把凭据、路径和查询参数混入地址。 */
export function normalizeGateway(value: string): string {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  )
    throw Error('请填写服务器根地址；远程服务器必须使用 HTTPS')
  return url.origin
}

export function activeServer(config: Config): ServerProfile {
  const server = config.servers.find((item) => item.id === config.activeServerId)
  if (!server) throw Error('当前服务器配置不存在')
  return server
}

/** 重复添加同一服务器返回原配置，不能覆盖已保存的设备凭据。 */
export function addServer(config: Config, gateway: string, name?: string): ServerProfile {
  const origin = normalizeGateway(gateway)
  const existing = config.servers.find((server) => server.gateway === origin)
  if (existing) return existing
  if (config.servers.length >= 20) throw Error('最多保存 20 个服务器')
  const server: ServerProfile = {
    id: randomUUID(),
    name: name?.trim().slice(0, 80) || new URL(origin).host,
    gateway: origin,
    paused: false,
    workspaces: [],
  }
  config.servers.push(server)
  return server
}

/** 切换只改变当前连接，不改变任何服务器的配对身份或工作区权限。 */
export function selectServer(config: Config, id: string): ServerProfile {
  const server = config.servers.find((item) => item.id === id)
  if (!server) throw Error('服务器不存在')
  config.activeServerId = id
  return server
}

/** 创建或重新授权当前服务器的工作区访问；重新授权时恢复只读默认值，不自动扩大写权限。 */
export function authorizeWorkspace(
  server: ServerProfile,
  workspaceId: string,
): WorkspaceAuthorization {
  let grant = server.workspaces.find((item) => item.workspaceId === workspaceId)
  if (!grant) {
    grant = {
      workspaceId,
      id: randomUUID(),
      authorized: true,
      enabled: true,
      permissions: { read: true, write: false },
      policies: { ...defaultWorkspacePolicies },
    }
    server.workspaces.push(grant)
  } else if (!grant.authorized) {
    grant.authorized = true
    grant.enabled = true
    grant.permissions = { read: true, write: false }
    grant.policies = { ...defaultWorkspacePolicies }
  }
  return grant
}

/** 接受 Server 的撤销确认，只移除当前服务器对应授权，保留本机目录与其他服务器授权。 */
export function applyWorkspaceRevocations(server: ServerProfile, ids: string[]): string[] {
  const revoked = new Set(ids)
  const removed = server.workspaces.filter((grant) => revoked.has(grant.id))
  server.workspaces = server.workspaces.filter((grant) => !revoked.has(grant.id))
  return removed.map((grant) => grant.id)
}

/** 返回该服务器实际获授权的工作区；远程 ID 在每台服务器中独立且保持不变。 */
export function serverWorkspaces(config: Config, server = activeServer(config)): LocalWorkspace[] {
  return server.workspaces.flatMap((grant) => {
    const workspace = config.workspaces.find((item) => item.id === grant.workspaceId)
    if (!grant.authorized || !workspace) return []
    return [
      {
        ...workspace,
        id: grant.id,
        enabled: grant.enabled,
        permissions: { ...grant.permissions },
        policies: normalizePolicies(grant.policies),
      },
    ]
  })
}

/** 本地页面始终展示目录清单；未授权给当前服务器的目录默认没有任何读写权限。 */
export function workspaceViews(config: Config) {
  const server = activeServer(config)
  return config.workspaces.map((workspace) => {
    const grant = server.workspaces.find((item) => item.workspaceId === workspace.id)
    const authorized = grant?.authorized === true
    return {
      ...workspace,
      serverId: server.id,
      authorized,
      enabled: authorized && grant.enabled,
      permissions: authorized ? { ...grant.permissions } : { read: false, write: false },
      policies: authorized
        ? normalizePolicies(grant.policies)
        : { file: 'deny', git: 'deny', command: 'deny' },
      commands: workspace.commands || [],
    }
  })
}

/** 从旧版单服务器配置转换为当前多服务器配置结构。 */
export function migrateConfig(
  value:
    | Config
    | {
        gateway: string
        deviceId?: string
        deviceToken?: string
        name: string
        workspaces: LocalWorkspace[]
      },
): Config {
  if ('version' in value && value.version === 2) {
    activeServer(value)
    return value
  }
  if (!('gateway' in value) || !Array.isArray(value.workspaces)) throw Error('Runtime 配置格式无效')
  const serverId = randomUUID()
  return {
    version: 2,
    name: value.name,
    activeServerId: serverId,
    workspaces: value.workspaces.map(({ id, name, root, commands }) => ({
      id,
      name,
      root,
      commands,
    })),
    servers: [
      {
        id: serverId,
        name: new URL(value.gateway).host,
        gateway: normalizeGateway(value.gateway),
        deviceId: value.deviceId,
        deviceToken: value.deviceToken,
        paused: false,
        workspaces: value.workspaces.map((workspace) => ({
          workspaceId: workspace.id,
          id: workspace.id,
          authorized: true,
          enabled: workspace.enabled,
          permissions: { ...workspace.permissions },
          policies: normalizePolicies(workspace.policies),
        })),
      },
    ],
  }
}

/** Runtime 配置存储位置，默认是当前用户私有目录。 */
export const dataDir = process.env.RUNTIME_DATA_DIR || path.join(os.homedir(), '.remote-code-mcp')
const file = path.join(dataDir, 'config.json')
/** 读取本机配置；首次启动创建默认服务器，旧版配置升级后先备份再原子保存。 */
export async function load(): Promise<Config> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    const config: Config = {
      version: 2,
      name: os.hostname(),
      activeServerId: '',
      servers: [],
      workspaces: [],
    }
    config.activeServerId = addServer(config, process.env.GATEWAY_URL || 'http://localhost:3000').id
    return config
  }
  const raw = JSON.parse(text)
  const config = migrateConfig(raw)
  if (raw.version !== 2) {
    try {
      await fs.writeFile(path.join(dataDir, 'config.v1.backup.json'), text, {
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    await save(config)
  }
  return config
}

let saveQueue: Promise<void> = Promise.resolve()
/** 串行、原子保存配置，避免切换、配对和授权的并发保存互相覆盖。 */
export function save(cfg: Config): Promise<void> {
  const operation = saveQueue
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
      const tmp = path.join(dataDir, '.tmp-' + randomUUID())
      try {
        await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
        await fs.rename(tmp, file)
        if (process.platform !== 'win32') await fs.chmod(file, 0o600)
      } finally {
        await fs.rm(tmp, { force: true })
      }
    })
  saveQueue = operation
  return operation
}

/** 只同步稳定 ID、用户设置的显示名和权限，不同步任何本地路径信息。 */
export const publicWs = (w: LocalWorkspace): WorkspacePublic => ({
  id: w.id,
  name: w.name,
  permissions: w.permissions,
  policies: normalizePolicies(w.policies),
  enabled: w.enabled,
})
