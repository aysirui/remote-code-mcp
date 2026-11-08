import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { WorkspacePublic } from '@rcm/protocol'
export type LocalWorkspace = WorkspacePublic & { root: string }
export type Config = {
  gateway: string
  deviceId?: string
  deviceToken?: string
  name: string
  workspaces: LocalWorkspace[]
}
export const dataDir = process.env.RUNTIME_DATA_DIR || path.join(os.homedir(), '.remote-code-mcp')
const file = path.join(dataDir, 'config.json')
export async function load(): Promise<Config> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e
    return {
      gateway: process.env.GATEWAY_URL || 'http://localhost:3000',
      name: os.hostname(),
      workspaces: [],
    }
  }
}
export async function save(cfg: Config) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dataDir, '.tmp-' + randomUUID())
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  await fs.rename(tmp, file)
  if (process.platform !== 'win32') await fs.chmod(file, 0o600)
}
export const publicWs = (w: LocalWorkspace): WorkspacePublic => ({
  id: w.id,
  name: w.name,
  permissions: w.permissions,
  enabled: w.enabled,
})
