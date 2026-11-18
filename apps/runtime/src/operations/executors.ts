import fs from 'node:fs/promises'
import {
  ToolInputs,
  ToolOutputs,
  type ToolOutput,
  operationRequiresWrite,
  type RpcRequest,
  type CommandAudit,
} from '@rcm/protocol'
import { policyForOperation, type LocalWorkspace } from '../workspace/state'
import { resolveSafe, isSensitive, assertSafeRelativePath } from './file/path-safety'
import {
  readChecked,
  searchChecked,
  writeChecked,
  mkdirChecked,
  moveChecked,
  deleteChecked,
  sha,
} from './file/file-operations'
import {
  runCheckedCommand,
  CommandResultError,
  listCommands,
  resolveCommandRequest,
} from './command/command-operations'
import {
  gitStatus,
  gitLog,
  gitDiff,
  gitAdd,
  gitCommit,
  gitApprovalContext,
} from './git/git-operations'

/** 工作区访问权限的唯一校验入口，供请求处理和执行器复用。 */
export function assertRequestAccess(w: LocalWorkspace, req: RpcRequest): void {
  if (req.workspaceId !== w.id) throw Error('WORKSPACE_ID_MISMATCH')
  if (req.deadlineAt < Date.now()) throw Error('REQUEST_EXPIRED')
  if (!w.enabled) throw Error('WORKSPACE_DISABLED')
  if (!w.permissions.read || (operationRequiresWrite(req.operation) && !w.permissions.write))
    throw Error('PERMISSION_DENIED')
  if (policyForOperation(w, req.operation) === 'deny') throw Error('POLICY_DENIED')
}

/** 保持路径安全检查为工具执行器的公共入口，便于安全测试直接调用。 */
export { resolveSafe } from './file/path-safety'

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
      assertSafeRelativePath(p.path)
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
      resolveCommandRequest(w, req.payload)
      return
    }
  }
}

/** Runtime 工具调度，使用共享输入契约校验请求，并在返回前校验原始操作结果。
 * 每次请求先校验工作区 ID、截止时间、读写授权及 Zod 参数，
 * 再调用文件/Git/Command 各自的领域执行器；拒绝任意 Shell。
 * @param w 本机已授权工作区，提供路径、权限及策略。
 * @param req 待执行的 RPC 请求，包含工作区标识、操作、参数和截止时间。
 * @param approvalResourceHash 本机审批绑定的资源指纹，用于执行前检查资源是否变化。
 * @param onCommandExecution 命令实际执行时接收脱敏审计元数据的回调。
 * @returns 符合对应 ToolOutputs 契约的原始业务结果，不含 MCP 包装。
 */
export async function execute(
  w: LocalWorkspace,
  req: RpcRequest,
  approvalResourceHash?: string,
  onCommandExecution?: (command: CommandAudit) => void,
): Promise<ToolOutput> {
  assertRequestAccess(w, req)
  await validateOperationSafety(w, req)
  let data: unknown
  switch (req.operation) {
    case 'file.list': {
      const payload = ToolInputs['file.list'].parse(req.payload)
      const filename = await resolveSafe(w, payload.path)
      const stat = await fs.lstat(filename)
      if (!stat.isDirectory()) throw Error('NOT_DIRECTORY')
      data = (await fs.readdir(filename, { withFileTypes: true }))
        .filter((e) => !isSensitive(e.name) && !e.isSymbolicLink())
        .slice(0, 500)
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
      break
    }
    case 'file.read': {
      const payload = ToolInputs['file.read'].parse(req.payload)
      const content = await readChecked(w, payload.path)
      data = { content, sha256: sha(content) }
      break
    }
    case 'file.search': {
      const payload = ToolInputs['file.search'].parse(req.payload)
      data = await searchChecked(w, payload.path, payload.query)
      break
    }
    case 'file.write': {
      const payload = ToolInputs['file.write'].parse(req.payload)
      data = await writeChecked(w, payload.path, payload.content, payload.expectedSha256)
      break
    }
    case 'file.mkdir': {
      const payload = ToolInputs['file.mkdir'].parse(req.payload)
      data = await mkdirChecked(w, payload.path, payload.recursive)
      break
    }
    case 'file.move': {
      const payload = ToolInputs['file.move'].parse(req.payload)
      data = await moveChecked(w, payload.from, payload.to)
      break
    }
    case 'file.delete': {
      const payload = ToolInputs['file.delete'].parse(req.payload)
      data = await deleteChecked(
        w,
        payload.path,
        payload.recursive,
        payload.expectedSha256,
        approvalResourceHash,
      )
      break
    }
    case 'git.status':
      ToolInputs['git.status'].parse(req.payload)
      data = await gitStatus(w)
      break
    case 'git.log': {
      const payload = ToolInputs['git.log'].parse(req.payload)
      data = await gitLog(w, payload.limit)
      break
    }
    case 'git.diff':
      ToolInputs['git.diff'].parse(req.payload)
      data = await gitDiff(w)
      break
    case 'git.add': {
      const payload = ToolInputs['git.add'].parse(req.payload)
      data = await gitAdd(w, payload.paths, approvalResourceHash)
      break
    }
    case 'git.commit': {
      const payload = ToolInputs['git.commit'].parse(req.payload)
      data = await gitCommit(w, payload.message, approvalResourceHash)
      break
    }
    case 'command.list':
      ToolInputs['command.list'].parse(req.payload)
      // 只暴露本机登记命令的名称和 ID；可执行程序及固定参数仅在 Runtime 本地审批界面展示。
      data = listCommands(w).map(({ id, name }) => ({ id, name }))
      break
    case 'command.run': {
      const payload = ToolInputs['command.run'].parse(req.payload)
      const result = await runCheckedCommand(
        w,
        payload,
        approvalResourceHash,
        undefined,
        onCommandExecution,
      )
      // 只向调用方返回已校验的业务字段；超时优先于进程给出的退出码。
      const commandResult = ToolOutputs['command.run'].safeParse(result)
      if (!commandResult.success) throw Error('INVALID_TOOL_RESULT')
      if (result.timedOut) throw new CommandResultError('COMMAND_TIMEOUT', commandResult.data)
      if (result.exitCode === null)
        throw new CommandResultError('COMMAND_PROCESS_TERMINATED', commandResult.data)
      if (result.exitCode !== 0)
        throw new CommandResultError('COMMAND_EXIT_NONZERO', commandResult.data)
      return commandResult.data
    }
    default:
      throw Error('UNSUPPORTED_OPERATION')
  }
  // 在 RPC 返回边界按操作校验原始结果，MCP 包装复用同一份输出字段定义。
  const result = ToolOutputs[req.operation].safeParse(data)
  if (!result.success) throw Error('INVALID_TOOL_RESULT')
  return result.data
}
