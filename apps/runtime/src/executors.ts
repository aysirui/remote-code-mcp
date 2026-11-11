import fs from 'node:fs/promises'
import path from 'node:path'
import { ToolInputs, operationRequiresWrite, type RpcRequest } from '@rcm/protocol'
import { policyForOperation, type LocalWorkspace } from './state'
import { resolveSafe, isSensitive, assertSafeRelativePath } from './path-safety'
import {
  readChecked,
  writeChecked,
  mkdirChecked,
  moveChecked,
  deleteChecked,
  sha,
} from './file-operations'
import { runCheckedCommand, listCommands, resolveCommand } from './command-operations'
import { gitStatus, gitLog, gitDiff, gitAdd, gitCommit, gitApprovalContext } from './git-operations'

/** 保持路径安全检查为工具执行器的公共入口，便于安全测试直接调用。 */
export { resolveSafe } from './path-safety'

/** 在审批前执行参数与路径 Hard Deny 检查；该函数不产生文件系统副作用。 */
export async function validateOperationSafety(w: LocalWorkspace, req: RpcRequest): Promise<void> {
  switch (req.operation) {
    case 'file.list': {
      const p = ToolInputs['file.list'].parse(req.payload)
      await resolveSafe(w, p.path)
      return
    }
    case 'file.read': {
      const p = ToolInputs['file.read'].parse(req.payload)
      await resolveSafe(w, p.path)
      return
    }
    case 'file.search': {
      const p = ToolInputs['file.search'].parse(req.payload)
      await resolveSafe(w, p.path)
      return
    }
    case 'file.write': {
      const p = ToolInputs['file.write'].parse(req.payload)
      await resolveSafe(w, p.path, true)
      return
    }
    case 'file.mkdir': {
      const p = ToolInputs['file.mkdir'].parse(req.payload)
      assertSafeRelativePath(p.path)
      const parts = p.path.split('/')
      if (!p.recursive) {
        await resolveSafe(w, parts.slice(0, -1).join('/') || '.')
      } else {
        // 递归创建只允许从最近一个真实存在且已验证的父目录向下创建。
        let parentFound = false
        for (let length = parts.length - 1; length >= 0; length--) {
          const parent = parts.slice(0, length).join('/') || '.'
          try {
            await resolveSafe(w, parent)
            parentFound = true
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        if (!parentFound) throw Error('HARD_DENY_INVALID_PARENT')
      }
      return
    }
    case 'file.move': {
      const p = ToolInputs['file.move'].parse(req.payload)
      await resolveSafe(w, p.from)
      await resolveSafe(w, p.to, true)
      return
    }
    case 'file.delete': {
      const p = ToolInputs['file.delete'].parse(req.payload)
      await resolveSafe(w, p.path)
      return
    }
    case 'git.status':
    case 'git.log':
    case 'git.diff':
      await resolveSafe(w, '.')
      return
    case 'git.add': {
      const p = ToolInputs['git.add'].parse(req.payload)
      await gitApprovalContext(w, req.operation, p)
      return
    }
    case 'git.commit': {
      const p = ToolInputs['git.commit'].parse(req.payload)
      await gitApprovalContext(w, req.operation, p)
      return
    }
    case 'command.list':
      ToolInputs['command.list'].parse(req.payload)
      return
    case 'command.run': {
      const p = ToolInputs['command.run'].parse(req.payload)
      resolveCommand(w, p.command)
      return
    }
  }
}

/** Runtime 工具调度。
 * 每次请求先校验工作区 ID、截止时间、读写授权及 Zod 参数，
 * 再调用文件/Git/Command 各自的领域执行器；拒绝任意 Shell。
 */
export async function execute(w: LocalWorkspace, req: RpcRequest, approvalResourceHash?: string) {
  if (req.workspaceId !== w.id) throw Error('WORKSPACE_ID_MISMATCH')
  if (req.deadlineAt < Date.now()) throw Error('REQUEST_EXPIRED')
  if (!w.enabled) throw Error('WORKSPACE_DISABLED')
  if (!w.permissions.read || (operationRequiresWrite(req.operation) && !w.permissions.write))
    throw Error('PERMISSION_DENIED')
  if (policyForOperation(w, req.operation) === 'deny') throw Error('POLICY_DENIED')
  await validateOperationSafety(w, req)
  switch (req.operation) {
    case 'file.list': {
      const payload = ToolInputs['file.list'].parse(req.payload)
      const filename = await resolveSafe(w, payload.path)
      const stat = await fs.lstat(filename)
      if (!stat.isDirectory()) throw Error('NOT_DIRECTORY')
      return (await fs.readdir(filename, { withFileTypes: true }))
        .filter((e) => !isSensitive(e.name) && !e.isSymbolicLink())
        .slice(0, 500)
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
    }
    case 'file.read': {
      const payload = ToolInputs['file.read'].parse(req.payload)
      const content = await readChecked(w, payload.path)
      return { content, sha256: sha(content) }
    }
    case 'file.search': {
      const payload = ToolInputs['file.search'].parse(req.payload)
      await resolveSafe(w, payload.path)
      const matches: Array<{ path: string; line: number; text: string }> = []
      const visited = new Set<string>()
      let count = 0
      async function visit(relative: string) {
        if (++count > 2000 || matches.length >= 100) return
        let current: string
        try {
          current = await resolveSafe(w, relative)
        } catch {
          return
        }
        if (visited.has(current)) return
        visited.add(current)
        const stat = await fs.lstat(current)
        if (stat.isFile()) {
          let source: string
          try {
            source = await readChecked(w, relative, 256 * 1024)
          } catch {
            return
          }
          for (const [i, line] of source.split('\n').entries()) {
            if (line.includes(payload.query))
              matches.push({ path: relative, line: i + 1, text: line.slice(0, 250) })
            if (matches.length >= 100) break
          }
        } else if (stat.isDirectory()) {
          for (const child of await fs.readdir(current, { withFileTypes: true })) {
            if (isSensitive(child.name) || child.isSymbolicLink()) continue
            await visit(path.posix.join(relative, child.name))
            if (matches.length >= 100 || count > 2000) break
          }
        }
      }
      await visit(payload.path)
      return matches
    }
    case 'file.write': {
      const payload = ToolInputs['file.write'].parse(req.payload)
      return writeChecked(w, payload.path, payload.content, payload.expectedSha256)
    }
    case 'file.mkdir': {
      const payload = ToolInputs['file.mkdir'].parse(req.payload)
      return mkdirChecked(w, payload.path, payload.recursive)
    }
    case 'file.move': {
      const payload = ToolInputs['file.move'].parse(req.payload)
      return moveChecked(w, payload.from, payload.to)
    }
    case 'file.delete': {
      const payload = ToolInputs['file.delete'].parse(req.payload)
      return deleteChecked(w, payload.path, payload.recursive, payload.expectedSha256)
    }
    case 'git.status':
      ToolInputs['git.status'].parse(req.payload)
      return gitStatus(w)
    case 'git.log': {
      const payload = ToolInputs['git.log'].parse(req.payload)
      return gitLog(w, payload.limit)
    }
    case 'git.diff':
      ToolInputs['git.diff'].parse(req.payload)
      return gitDiff(w)
    case 'git.add': {
      const payload = ToolInputs['git.add'].parse(req.payload)
      return gitAdd(w, payload.paths, approvalResourceHash)
    }
    case 'git.commit': {
      const payload = ToolInputs['git.commit'].parse(req.payload)
      return gitCommit(w, payload.message, approvalResourceHash)
    }
    case 'command.list':
      ToolInputs['command.list'].parse(req.payload)
      // 只暴露本机登记命令的名称和 ID；可执行程序及固定参数仅在 Runtime 本地审批界面展示。
      return listCommands(w).map(({ id, name }) => ({ id, name }))
    case 'command.run': {
      const payload = ToolInputs['command.run'].parse(req.payload)
      return runCheckedCommand(w, payload.command)
    }
    default:
      throw Error('UNSUPPORTED_OPERATION')
  }
}
