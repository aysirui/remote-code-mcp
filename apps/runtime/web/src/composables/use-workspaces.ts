import { ref, type Ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { RuntimeStatus, WorkspaceView, CommandView, DirectoryBrowser } from '../types/runtime'

/** 工作区、权限策略和固定命令登记仅通过 Runtime 本地 API 管理。 */
export function useWorkspaces(
  status: Ref<RuntimeStatus>,
  api: <T = unknown>(
    path: string,
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    data?: unknown,
  ) => Promise<T>,
  refresh: () => Promise<void>,
  reportError: (error: unknown) => void,
) {
  const folder = ref('')
  const folderName = ref('')
  const showAdd = ref(false)
  const browse = ref<DirectoryBrowser | null>(null)
  const commandWorkspace = ref<WorkspaceView | null>(null)
  const commandId = ref('')
  const commandName = ref('')
  const commandExecutable = ref('')
  const commandArgs = ref('[]')

  /** 独立切换当前服务器对本地工作区的授权，不影响其他服务器的授权记录。 */
  async function toggleWorkspaceAuthorization(workspace: WorkspaceView) {
    try {
      await ElMessageBox.confirm(
        workspace.authorized
          ? `停止向当前服务器开放 ${workspace.name}？其他服务器的权限保持不变。`
          : `允许当前服务器只读访问 ${workspace.name}？`,
        workspace.authorized ? '取消工作区授权' : '授权工作区',
        { type: 'warning' },
      )
      await api('workspaces/' + workspace.id, 'PATCH', {
        serverId: workspace.serverId,
        authorized: !workspace.authorized,
      })
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 在 Runtime 本机浏览目录；绝对路径只返回本地页面，不同步到 Gateway。 */
  async function openBrowse(p?: string) {
    try {
      browse.value = await api<DirectoryBrowser>(
        'browse' + (p ? '?path=' + encodeURIComponent(p) : ''),
      )
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 将当前浏览位置设为待授权工作区根目录。 */
  function pickDir() {
    if (!browse.value) return
    folder.value = browse.value.path
    browse.value = null
  }

  /** 将用户选择的本地目录登记为工作区，初始权限遵循只读默认策略。 */
  async function addWorkspace() {
    try {
      await api('workspaces', 'POST', {
        serverId: status.value.serverId,
        root: folder.value,
        name: folderName.value,
      })
      showAdd.value = false
      folder.value = ''
      folderName.value = ''
      await refresh()
      ElMessage.success('工作区授权成功')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 修改工作区读写开关；扩大写权限前要求用户明确确认。 */
  async function toggleWrite(w: WorkspaceView) {
    try {
      if (!w.permissions.write)
        await ElMessageBox.confirm(
          '允许 AI 修改这个项目的文件？仅对你明确授权的工作区开放。',
          '开启写入权限',
          { type: 'warning' },
        )
      await api('workspaces/' + w.id, 'PATCH', {
        serverId: w.serverId,
        write: !w.permissions.write,
      })
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 修改本地 File/Git/Command 策略；allow 会展示风险说明并要求再次确认。 */
  async function changePolicy(
    w: WorkspaceView,
    domain: 'file' | 'git' | 'command',
    policy: 'deny' | 'approval' | 'allow',
  ) {
    if (policy === w.policies[domain]) return
    try {
      if (policy === 'allow') {
        const description =
          domain === 'command'
            ? '内置及已登记命令将免逐次审批，以本机账号权限执行，可访问项目外文件和网络。未登记命令仍需单次审批。'
            : domain === 'file'
              ? '文件工具将在不逐次确认的情况下执行；工作区读写开关及路径 Hard Deny 仍然生效。'
              : 'Git 工具将在不逐次确认的情况下执行；Git 固定子命令及环境隔离仍然生效。'
        await ElMessageBox.confirm(description, '确认设为完全允许', {
          type: 'warning',
          confirmButtonText: '确认允许',
        })
      }
      await api('workspaces/' + w.id, 'PATCH', {
        serverId: w.serverId,
        policies: { [domain]: policy },
      })
      await refresh()
      ElMessage.success(domain + ' 权限策略已更新')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 打开当前工作区的本地命令登记表单，远程 AI 无法编辑命令定义。 */
  function showCommandForm(w: WorkspaceView) {
    commandWorkspace.value = w
    commandId.value = ''
    commandName.value = ''
    commandExecutable.value = ''
    commandArgs.value = '[]'
  }

  /** 保存本地固定命令定义；临时命令通过单次审批执行，不会自动登记。 */
  async function addCommand() {
    const workspace = commandWorkspace.value
    if (!workspace) return
    try {
      const args: unknown = JSON.parse(commandArgs.value)
      if (!Array.isArray(args) || !args.every((item) => typeof item === 'string'))
        throw Error('参数必须是 JSON 字符串数组，例如 ["run", "lint"]')
      await api('workspaces/' + workspace.id + '/commands', 'POST', {
        id: commandId.value,
        name: commandName.value,
        executable: commandExecutable.value,
        args,
      })
      commandWorkspace.value = null
      await refresh()
      ElMessage.success('本地命令已添加')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 删除本地命令登记项；审批中的命令会在执行前重新校验指纹。 */
  async function deleteCommand(w: WorkspaceView, command: CommandView) {
    try {
      await ElMessageBox.confirm(
        '确认移除 ' + command.name + '？这会使尚未完成的审批请求失效。',
        '移除本地命令',
        { type: 'warning', confirmButtonText: '移除命令', confirmButtonType: 'danger' },
      )
      await api('workspaces/' + w.id + '/commands/' + encodeURIComponent(command.id), 'DELETE')
      await refresh()
      ElMessage.success('本地命令已移除')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 移除本地工作区登记及其服务器授权，并取消该工作区的待审批任务。 */
  async function remove(w: WorkspaceView) {
    try {
      await ElMessageBox.confirm(
        '确认从本机目录清单及所有服务器授权中移除 ' + w.name + '？本地文件会保留。',
        '移除工作区',
        { type: 'warning', confirmButtonText: '移除工作区', confirmButtonType: 'danger' },
      )
      await api('workspaces/' + w.id, 'DELETE')
      await refresh()
    } catch (error: unknown) {
      reportError(error)
    }
  }

  return {
    folder,
    folderName,
    showAdd,
    browse,
    commandWorkspace,
    commandId,
    commandName,
    commandExecutable,
    commandArgs,
    toggleWorkspaceAuthorization,
    openBrowse,
    pickDir,
    addWorkspace,
    toggleWrite,
    changePolicy,
    showCommandForm,
    addCommand,
    deleteCommand,
    remove,
  }
}
