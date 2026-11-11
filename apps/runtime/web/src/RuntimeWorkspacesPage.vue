<script setup lang="ts">
import { inject } from 'vue'
import type { RuntimeContext } from './use-runtime-console'
import {
  Plus,
  FolderOpened,
  MoreFilled,
  Delete,
  Lock,
  Unlock,
  Key,
  CircleCheck,
  Setting,
} from '@element-plus/icons-vue'

const {
  status,
  workspaces,
  toggleWorkspaceAuthorization,
  showAdd,
  folder,
  folderName,
  browse,
  openBrowse,
  pickDir,
  addWorkspace,
  toggleWrite,
  changePolicy,
  commandWorkspace,
  commandId,
  commandName,
  commandExecutable,
  commandArgs,
  showCommandForm,
  addCommand,
  deleteCommand,
  remove,
} = inject<RuntimeContext>('runtime')!

type Workspace = (typeof workspaces.value)[number]
function onWorkspaceAction(action: string, workspace: Workspace) {
  switch (action) {
    case 'authorization':
      void toggleWorkspaceAuthorization(workspace)
      break
    case 'command':
      showCommandForm(workspace)
      break
    case 'remove':
      void remove(workspace)
      break
  }
}
</script>

<template>
  <section class="card workspace-page">
    <header class="workspace-page-header">
      <div class="workspace-heading">
        <h1>本地工作区</h1>
        <div class="workspace-server">
          当前服务器 <strong>{{ status.serverName }}</strong> <span>·</span> {{ status.gateway }}
        </div>
      </div>
      <el-button type="primary" :icon="Plus" @click="showAdd = true">添加项目</el-button>
    </header>
    <p class="workspace-description">
      管理当前服务器对本地项目的访问权限。File、Git、Command 策略分别配置，各服务器之间相互独立。Git
      暂存和提交始终需要本机逐次确认。
    </p>

    <el-empty v-if="!workspaces.length" description="尚未添加本地工作区" />

    <div v-else class="workspace-grid">
      <article v-for="w in workspaces" :key="w.id" class="workspace-card">
        <div class="workspace-card-main">
          <div class="workspace-folder-icon" aria-hidden="true">
            <el-icon><FolderOpened /></el-icon>
          </div>
          <div class="workspace-identity">
            <div class="workspace-name">{{ w.name }}</div>
            <div class="workspace-path" :title="w.root">{{ w.root }}</div>
          </div>
          <div class="workspace-badges">
            <el-tag
              size="small"
              effect="light"
              :type="
                !w.authorized
                  ? 'info'
                  : !w.enabled
                    ? 'info'
                    : w.permissions.write
                      ? 'warning'
                      : 'success'
              "
            >
              {{
                !w.authorized
                  ? '未授权'
                  : !w.enabled
                    ? '已停用'
                    : w.permissions.write
                      ? '可读写'
                      : '只读'
              }}
            </el-tag>
          </div>
          <el-dropdown
            trigger="click"
            placement="bottom-end"
            @command="(action: string) => onWorkspaceAction(action, w)"
          >
            <el-button
              class="workspace-more"
              :icon="MoreFilled"
              circle
              text
              :aria-label="`管理 ${w.name} 的更多操作`"
            />
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="authorization" :icon="w.authorized ? Lock : Unlock">
                  {{ w.authorized ? '取消当前服务器授权' : '授权当前服务器' }}
                </el-dropdown-item>
                <el-dropdown-item
                  command="command"
                  :icon="Setting"
                  :disabled="!w.authorized || !w.enabled"
                  >添加本地命令</el-dropdown-item
                >
                <el-dropdown-item command="remove" :icon="Delete" divided class="workspace-danger"
                  >从本地移除项目</el-dropdown-item
                >
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <div class="workspace-card-footer">
          <div class="workspace-policy workspace-policy-grid">
            <div
              v-for="domain in ['file', 'git', 'command'] as const"
              :key="domain"
              class="policy-item"
            >
              <span class="workspace-field-label">{{
                { file: 'File', git: 'Git', command: 'Command' }[domain]
              }}</span>
              <el-select
                :model-value="w.policies[domain]"
                :disabled="!w.authorized || !w.enabled"
                :aria-label="domain + ' 权限策略'"
                size="small"
                class="workspace-policy-select"
                @change="(policy: 'deny' | 'approval' | 'allow') => changePolicy(w, domain, policy)"
              >
                <el-option label="禁止" value="deny" />
                <el-option label="审批执行" value="approval" />
                <el-option label="完全允许" value="allow" />
              </el-select>
            </div>
          </div>
          <div class="workspace-card-actions">
            <el-button
              v-if="!w.authorized"
              type="primary"
              :icon="Unlock"
              @click="toggleWorkspaceAuthorization(w)"
              >授权访问</el-button
            >
            <el-button
              v-else
              :type="w.permissions.write ? '' : 'primary'"
              :icon="w.permissions.write ? Lock : Key"
              :disabled="!w.enabled"
              @click="toggleWrite(w)"
              >{{ w.permissions.write ? '设为只读' : '开启写入' }}</el-button
            >
          </div>
        </div>
        <div v-if="w.commands?.length" class="workspace-command-section">
          <div class="workspace-command-heading">
            <el-icon><CircleCheck /></el-icon> 已配置命令 <span>{{ w.commands.length }}</span>
          </div>
          <div v-for="cmd in w.commands" :key="cmd.id" class="workspace-command-row">
            <div class="workspace-command-details">
              <strong>{{ cmd.name }}</strong>
              <span class="workspace-command-code"
                >{{ cmd.executable }} {{ cmd.args.join(' ') }}</span
              >
            </div>
            <el-button text type="danger" size="small" @click="deleteCommand(w, cmd)"
              >移除</el-button
            >
          </div>
        </div>
      </article>
    </div>
  </section>
  <el-dialog
    :model-value="!!commandWorkspace"
    title="添加工作区命令"
    width="min(560px, 95vw)"
    @close="commandWorkspace = null"
  >
    <el-alert
      title="命令定义供本机目录共用；是否逐次审批由 Command 权限策略决定，Hard Deny 始终生效。"
      type="warning"
      :closable="false"
      style="margin-bottom: 18px"
    />
    <el-form label-position="top" @submit.prevent="addCommand">
      <el-form-item label="命令 ID（英文小写，唯一）">
        <el-input v-model="commandId" placeholder="lint-check" maxlength="40" />
      </el-form-item>
      <el-form-item label="显示名称">
        <el-input v-model="commandName" placeholder="检查项目代码" maxlength="80" />
      </el-form-item>
      <el-form-item label="可执行程序">
        <el-input v-model="commandExecutable" placeholder="例如 pnpm、tsc 或绝对路径" />
      </el-form-item>
      <el-form-item label="固定参数（JSON 字符串数组）">
        <el-input v-model="commandArgs" type="textarea" :rows="3" placeholder='["--version"]' />
      </el-form-item>
      <div class="muted">
        不能配置 Shell
        脚本文件。命令运行时可能访问工作区之外的文件，务必使用低权限账户，并只添加可信程序。
      </div>
    </el-form>
    <template #footer>
      <el-button @click="commandWorkspace = null">取消</el-button>
      <el-button
        type="primary"
        :disabled="!commandId || !commandName || !commandExecutable"
        @click="addCommand"
        >保存本地命令</el-button
      >
    </template>
  </el-dialog>
  <el-dialog v-model="showAdd" title="添加本地工作区" width="min(520px,95vw)"
    ><el-form label-position="top"
      ><el-form-item label="项目文件夹绝对路径"
        ><div class="row" style="width: 100%">
          <el-input v-model="folder" placeholder="选择或输入项目文件夹路径" /><el-button
            @click="openBrowse(folder || undefined)"
            >浏览目录</el-button
          >
        </div>
        <div class="fine">
          本地文件夹路径只保存在 Runtime 中；云端仅获取项目名称与权限。
        </div></el-form-item
      ><el-form-item label="显示名称（可选）"
        ><el-input v-model="folderName" placeholder="my-app" /></el-form-item></el-form
    ><el-alert
      title="默认只读"
      description="仅向当前服务器授予只读权限，其他服务器不会自动获得访问权限。写入权限可稍后单独开启。"
      type="info"
      :closable="false"
    /><template #footer
      ><el-button @click="showAdd = false">取消</el-button
      ><el-button type="primary" :disabled="!folder" @click="addWorkspace"
        >授权此目录</el-button
      ></template
    ></el-dialog
  >
  <el-dialog
    :model-value="!!browse"
    title="选择本地项目目录"
    width="min(620px,95vw)"
    @close="browse = null"
    ><template v-if="browse"
      ><div class="muted" style="word-break: break-all">当前目录：{{ browse.path }}</div>
      <el-button style="margin: 14px 0" @click="openBrowse(browse.parent)">上一级目录</el-button
      ><el-scrollbar max-height="330px"
        ><div
          v-for="d in browse.entries"
          :key="d.path"
          class="project row"
          style="cursor: pointer"
          @click="openBrowse(d.path)"
        >
          <el-icon><FolderOpened /></el-icon><span>{{ d.name }}</span>
        </div>
        <el-empty v-if="!browse.entries.length" description="没有子目录" /></el-scrollbar></template
    ><template #footer
      ><el-button @click="browse = null">取消</el-button
      ><el-button type="primary" @click="pickDir">选择此目录</el-button></template
    ></el-dialog
  >
</template>

<style scoped>
.workspace-page {
  padding: 30px;
}
.workspace-page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
}
.workspace-heading {
  min-width: 0;
}
.workspace-heading h1 {
  font-size: 22px;
  font-weight: 750;
  margin: 0 0 10px;
  letter-spacing: -0.02em;
}
.workspace-server {
  color: #7b8798;
  font-size: 12px;
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.workspace-server strong {
  color: #52647b;
  font-weight: 600;
}
.workspace-server span {
  margin: 0 5px;
}
.workspace-description {
  margin: 4px 0 16px;
  color: #8290a3;
  font-size: 13px;
  line-height: 1.6;
}
.workspace-grid {
  display: grid;
  gap: 14px;
}
.workspace-card {
  border: 1px solid #e7ecf3;
  border-radius: 12px;
  background: #fff;
  overflow: hidden;
  transition:
    border-color 0.18s,
    box-shadow 0.18s;
}
.workspace-card:hover {
  border-color: #d5e0ef;
  box-shadow: 0 5px 20px rgba(28, 48, 84, 0.045);
}
.workspace-card-main {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 20px 20px 19px;
}
.workspace-folder-icon {
  height: 44px;
  width: 44px;
  flex: 0 0 44px;
  display: grid;
  place-items: center;
  border-radius: 11px;
  background: #eff5ff;
  color: #3069df;
  font-size: 21px;
}
.workspace-identity {
  flex: 1;
  min-width: 0;
  padding-top: 1px;
}
.workspace-name {
  font-size: 16px;
  font-weight: 700;
  line-height: 1.5;
  color: #1c293e;
}
.workspace-path {
  font-size: 12px;
  line-height: 1.65;
  color: #8290a3;
  overflow-wrap: anywhere;
  margin-top: 4px;
}
.workspace-badges {
  padding-top: 5px;
}
.workspace-more {
  flex: 0 0 auto;
  color: #738297;
  margin: 0;
}
.workspace-more:hover {
  color: #2563eb;
  background: #f1f5fb;
}
.workspace-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 32px;
  padding: 12px 20px;
  background: #fafbfe;
  border-top: 1px solid #edf0f5;
}
.workspace-policy-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.policy-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.workspace-policy {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.workspace-field-label {
  color: #64748b;
  font-size: 12px;
  white-space: nowrap;
}
.workspace-policy-select {
  width: 134px;
}
.workspace-policy-disabled {
  font-size: 12px;
  color: #99a4b4;
}
.workspace-card-actions {
  flex-shrink: 0;
}
.workspace-card-actions .el-button {
  margin: 0;
}
.workspace-command-section {
  padding: 14px 20px 16px;
  border-top: 1px solid #edf0f5;
}
.workspace-command-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #64748b;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}
.workspace-command-heading span {
  padding: 1px 6px;
  border-radius: 9px;
  background: #f0f3f8;
}
.workspace-command-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
}
.workspace-command-row + .workspace-command-row {
  border-top: 1px solid #f0f2f6;
}
.workspace-command-details {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 3px;
  font-size: 13px;
}
.workspace-command-code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  color: #8793a5;
  overflow-wrap: anywhere;
}
@media (max-width: 650px) {
  .workspace-page {
    padding: 18px;
  }
  .workspace-page-header {
    align-items: center;
  }
  .workspace-page-header > .el-button {
    flex-shrink: 0;
  }
  .workspace-description {
    margin: 16px 0 20px;
  }
  .workspace-card-main {
    padding: 16px;
    gap: 11px;
    flex-wrap: wrap;
  }
  .workspace-folder-icon {
    width: 38px;
    height: 38px;
    flex-basis: 38px;
    font-size: 18px;
  }
  .workspace-identity {
    flex-basis: calc(100% - 100px);
  }
  .workspace-badges {
    padding-left: 49px;
    padding-top: 0;
  }
  .workspace-more {
    margin-left: auto;
  }
  .workspace-card-footer {
    padding: 12px 16px;
    flex-wrap: wrap;
  }
  .workspace-card-actions {
    margin-left: auto;
  }
  .workspace-command-section {
    padding: 12px 16px;
  }
}
@media (max-width: 400px) {
  .workspace-page-header {
    align-items: flex-start;
    flex-direction: column;
  }
  .workspace-card-footer {
    align-items: stretch;
    flex-direction: column;
  }
  .workspace-card-actions,
  .workspace-card-actions .el-button {
    width: 100%;
  }
}
</style>
