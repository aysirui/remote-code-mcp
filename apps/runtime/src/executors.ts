import fs from 'node:fs/promises'
import path from 'node:path'
import { ToolInputs, operationRequiresWrite, type RpcRequest } from '@rcm/protocol'
import type { LocalWorkspace } from './state'
import { resolveSafe, isSensitive } from './path-safety'
import {
  readChecked,
  writeChecked,
  mkdirChecked,
  moveChecked,
  deleteChecked,
  sha,
} from './file-operations'
import { runCheckedCommand, listCommands } from './command-operations'
import { gitStatus, gitDiff } from './git-operations'

/** 保持路径安全检查为工具执行器的公共入口，便于安全测试直接调用。 */
export { resolveSafe } from './path-safety'

/**
 * Runtime 工具调度。
 * 每次请求先校验工作区 ID、截止时间、读写授权及 Zod 参数，
 * 再调用文件/Git 领域执行器；只允许固定命令预设，拒绝任意 Shell。
 */
export async function execute(w: LocalWorkspace, req: RpcRequest) {
  if (req.workspaceId !== w.id) throw Error('WORKSPACE_ID_MISMATCH')
  if (req.deadlineAt < Date.now()) throw Error('REQUEST_EXPIRED')
  if (!w.enabled) throw Error('WORKSPACE_DISABLED')
  if (!w.permissions.read || (operationRequiresWrite(req.operation) && !w.permissions.write))
    throw Error('PERMISSION_DENIED')
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
    case 'command.list': {
      ToolInputs['command.list'].parse(req.payload)
      // 仅暴露命令名称和 ID；可执行程序及固定参数只在本地审批页面显示。
      return listCommands(w).map(({ id, name }) => ({ id, name }))
    }
    case 'command.run': {
      const payload = ToolInputs['command.run'].parse(req.payload)
      return runCheckedCommand(w, payload.command)
    }
    case 'git.status':
      return gitStatus(w)
    case 'git.diff':
      return gitDiff(w)
    default:
      throw Error('UNSUPPORTED_OPERATION')
  }
}
