<script setup lang="ts">
import { inject } from 'vue'
import type { RuntimeContext } from './use-runtime-console'
import { Plus, FolderOpened, Delete } from '@element-plus/icons-vue'
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
  changeWritePolicy,
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
</script>
<template>
  <div class="card">
    <div class="row between">
      <div>
        <div class="title">本地工作区</div>
        <div class="muted">当前服务器：{{ status.serverName }} · {{ status.gateway }}</div>
      </div>
      <el-button type="primary" :icon="Plus" @click="showAdd = true">添加项目</el-button>
    </div>
    <p class="muted">每台服务器的工作区授权和写入策略独立保存。新增服务器默认没有访问权限。</p>
    <el-empty v-if="!workspaces.length" description="尚未添加本地工作区" />
    <div v-for="w in workspaces" :key="w.id" class="project row">
      <div class="badge">
        <el-icon><FolderOpened /></el-icon>
      </div>
      <div class="workspace-info">
        <strong>{{ w.name }}</strong>
        <div class="muted" style="word-break: break-all">{{ w.root }}</div>
      </div>
      <el-tag :type="w.permissions.write ? 'warning' : 'info'">{{
        !w.authorized ? '未授权' : w.permissions.write ? '读写' : '只读'
      }}</el-tag>
      <el-button
        text
        :type="w.authorized ? 'danger' : 'primary'"
        @click="toggleWorkspaceAuthorization(w)"
        >{{ w.authorized ? '取消授权' : '授权当前服务器' }}</el-button
      >
      <el-select
        v-if="w.authorized && w.permissions.write && w.enabled"
        :model-value="w.writePolicy || 'approval'"
        style="width: 150px"
        aria-label="工作区写入策略"
        @change="(policy: 'auto' | 'approval') => changeWritePolicy(w, policy)"
      >
        <el-option label="逐次审批" value="approval" />
        <el-option label="自动写入" value="auto" />
      </el-select>
      <el-button v-if="w.authorized" text type="primary" @click="toggleWrite(w)">{{
        w.permissions.write ? '设为只读' : '开启写入'
      }}</el-button>
      <el-button
        text
        type="primary"
        :disabled="!w.authorized || !w.enabled"
        @click="showCommandForm(w)"
        >添加命令</el-button
      >
      <el-button
        text
        type="danger"
        :icon="Delete"
        :aria-label="`从本机清单移除 ${w.name}`"
        @click="remove(w)"
      />
      <div v-if="w.commands?.length" class="command-list">
        <div v-for="cmd in w.commands" :key="cmd.id" class="command-item">
          <div>
            <strong>{{ cmd.name }}</strong>
            <span class="muted"> · {{ cmd.id }}</span>
            <div class="muted command-line">{{ cmd.executable }} {{ cmd.args.join(' ') }}</div>
          </div>
          <el-button text type="danger" @click="deleteCommand(w, cmd)">移除命令</el-button>
        </div>
      </div>
    </div>
  </div>
  <el-dialog
    :model-value="!!commandWorkspace"
    title="添加工作区命令"
    width="min(560px, 95vw)"
    @close="commandWorkspace = null"
  >
    <el-alert
      title="命令定义供本机目录共用，仅已获读写授权的服务器可请求执行，每次仍需本地确认。"
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
        <el-input v-model="commandExecutable" placeholder="例如 node、git 或绝对路径" />
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
