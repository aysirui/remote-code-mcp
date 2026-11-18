import type { Router, Response } from 'express'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  activeServer,
  authorizeWorkspace,
  save,
  workspaceViews,
  type Config,
  type ServerProfile,
} from '../workspace/state'
import type { WriteApprovalQueue } from '../requests/write-approvals'
import type { LocalEvents } from './local-events'
import { validateLocalCommand } from '../operations/command/command-operations'
import { resolveSafe } from '../operations/file/path-safety'

/** 本地工作区路由只接收授权状态与配置能力，不管理 HTTP Server 生命周期。 */
export interface WorkspaceRoutesContext {
  api: Router
  config: Config
  approvals: WriteApprovalQueue
  events: LocalEvents
  sync: () => Promise<void>
  requireActiveServer: (id: unknown) => ServerProfile
  publishConfig: () => void
  fail: (res: Response, error: unknown) => Response
}

/** 注册工作区、命令清单和本地目录浏览路由。 */
export function registerWorkspaceRoutes(context: WorkspaceRoutesContext) {
  const { api, config, approvals, events, sync, requireActiveServer, publishConfig, fail } = context
  /** 仅在本地展示目录供用户选择工作区，绝对路径不发送到 Server。 */
  api.get('/browse', async (req, res) => {
    try {
      const dir = await fs.realpath(String(req.query.path || os.homedir()))
      const entry = await fs.stat(dir)
      if (!entry.isDirectory()) throw Error('Folder required')
      const entries = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((x) => x.isDirectory() && !x.name.startsWith('.'))
        .slice(0, 250)
        .map((x) => ({ name: x.name, path: path.join(dir, x.name) }))
      res.json({ path: dir, parent: path.dirname(dir), entries })
    } catch (error: unknown) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Browse failed' })
    }
  })

  /** 本地目录共用，各服务器的访问权限独立展示。 */
  api.get('/workspaces', (_req, res) => res.json(workspaceViews(config)))
  api.post('/workspaces', async (req, res) => {
    try {
      const server = requireActiveServer(req.body.serverId)
      const root = await fs.realpath(String(req.body.root || ''))
      if (!(await fs.stat(root)).isDirectory()) throw Error('目录不存在')
      await resolveSafe({ root }, '.')
      if ([os.homedir(), path.parse(root).root].includes(root))
        throw Error('不能授权整个用户目录或磁盘根目录')
      let workspace = config.workspaces.find((item) =>
        process.platform === 'win32'
          ? item.root.toLowerCase() === root.toLowerCase()
          : item.root === root,
      )
      if (!workspace) {
        workspace = {
          id: randomUUID(),
          name: String(req.body.name || path.basename(root)).slice(0, 128),
          root,
          commands: [],
        }
        config.workspaces.push(workspace)
      }
      authorizeWorkspace(server, workspace.id)
      await save(config)
      await sync()
      events.publish('workspaces')
      events.publish('status')
      res.json({ id: workspace.id })
    } catch (error: unknown) {
      fail(res, error)
    }
  })
  api.patch('/workspaces/:id', async (req, res) => {
    try {
      const server = requireActiveServer(req.body.serverId)
      const workspace = config.workspaces.find((item) => item.id === req.params.id)
      if (!workspace) throw Error('工作区不存在')
      const policyUpdates = req.body.policies
      if (policyUpdates !== undefined) {
        if (!policyUpdates || typeof policyUpdates !== 'object' || Array.isArray(policyUpdates))
          throw Error('访问策略无效')
        for (const domain of ['file', 'git', 'command'] as const) {
          const value = policyUpdates[domain]
          if (
            value !== undefined &&
            (typeof value !== 'string' || !['deny', 'approval', 'allow'].includes(value))
          )
            throw Error(domain + ' 策略无效')
        }
      }
      if (req.body.authorized !== undefined && typeof req.body.authorized !== 'boolean')
        throw Error('授权状态无效')
      let grant = server.workspaces.find((item) => item.workspaceId === workspace.id)
      if (req.body.authorized === true) grant = authorizeWorkspace(server, workspace.id)
      if (!grant || (!grant.authorized && req.body.authorized !== false))
        throw Error('请先授权此服务器访问工作区')
      const next = {
        ...grant,
        permissions: { ...grant.permissions },
        policies: { ...grant.policies },
      }
      if (req.body.authorized === false) next.authorized = false
      if (typeof req.body.enabled === 'boolean') next.enabled = req.body.enabled
      if (typeof req.body.write === 'boolean') next.permissions.write = req.body.write
      if (policyUpdates) {
        for (const domain of ['file', 'git', 'command'] as const) {
          const value = policyUpdates[domain]
          if (value !== undefined) next.policies[domain] = value
        }
      }
      if (!next.authorized) next.policies = { file: 'deny', git: 'deny', command: 'deny' }
      server.workspaces[server.workspaces.indexOf(grant)] = next
      approvals.rejectWorkspace(grant.id)
      await save(config)
      await sync()
      publishConfig()
      res.json({ ok: true })
    } catch (error: unknown) {
      fail(res, error)
    }
  })
  const rejectWorkspaceApprovals = (id: string) => {
    const grant = activeServer(config).workspaces.find((item) => item.workspaceId === id)
    if (grant) approvals.rejectWorkspace(grant.id)
  }

  /**
   * 用户只能从本机管理界面配置固定命令，不能通过远程 RPC 提交 executable 或 args。
   * 命令修改不改变云端授权元数据；待审批的旧命令请求必须失效。
   */
  api.post('/workspaces/:id/commands', async (req, res) => {
    try {
      const workspace = config.workspaces.find((w) => w.id === req.params.id)
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' })
      const command = validateLocalCommand(req.body)
      if ((workspace.commands || []).length >= 20) throw Error('TOO_MANY_COMMANDS')
      if ((workspace.commands || []).some((item) => item.id === command.id))
        throw Error('COMMAND_ALREADY_EXISTS')
      workspace.commands = [...(workspace.commands || []), command]
      await save(config)
      rejectWorkspaceApprovals(workspace.id)
      events.publish('workspaces')
      return res.json(command)
    } catch (error: unknown) {
      return res
        .status(400)
        .json({ error: error instanceof Error ? error.message : 'Invalid command' })
    }
  })

  /** 删除本地命令配置并取消所有待审批的工作区请求。 */
  api.delete('/workspaces/:id/commands/:commandId', async (req, res) => {
    try {
      const workspace = config.workspaces.find((w) => w.id === req.params.id)
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' })
      const current = workspace.commands || []
      if (!current.some((item) => item.id === req.params.commandId))
        return res.status(404).json({ error: 'Command not found' })
      workspace.commands = current.filter((item) => item.id !== req.params.commandId)
      await save(config)
      rejectWorkspaceApprovals(workspace.id)
      events.publish('workspaces')
      return res.json({ ok: true })
    } catch (error: unknown) {
      return res
        .status(400)
        .json({ error: error instanceof Error ? error.message : 'Delete failed' })
    }
  })

  /** 移除工作区授权并同步云端，同时立即拒绝该工作区的待审批操作。 */
  api.delete('/workspaces/:id', async (req, res) => {
    rejectWorkspaceApprovals(String(req.params.id))
    for (const server of config.servers)
      server.workspaces = server.workspaces.filter((grant) => grant.workspaceId !== req.params.id)
    config.workspaces = config.workspaces.filter((w) => w.id !== req.params.id)
    await save(config)
    await sync()
    events.publish('workspaces')
    res.json({ ok: true })
  })
}
