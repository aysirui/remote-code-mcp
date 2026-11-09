<script setup lang="ts">
import { inject } from 'vue'
import type { RuntimeContext } from './use-runtime-console'
import { Plus, FolderOpened, Delete } from '@element-plus/icons-vue'
const {
  workspaces,
  showAdd,
  folder,
  folderName,
  browse,
  openBrowse,
  pickDir,
  addWorkspace,
  toggleWrite,
  changeWritePolicy,
  remove,
} = inject<RuntimeContext>('runtime')!
</script>
<template>
  <div class="card">
    <div class="row between">
      <div>
        <div class="title">本地工作区</div>
        <div class="muted">只有你明确添加的目录可以被远程访问</div>
      </div>
      <el-button type="primary" :icon="Plus" @click="showAdd = true">添加项目</el-button>
    </div>
    <el-empty v-if="!workspaces.length" description="尚未授权任何本地工作区" />
    <div v-for="w in workspaces" :key="w.id" class="project row">
      <div class="badge">
        <el-icon><FolderOpened /></el-icon>
      </div>
      <div style="flex: 1; min-width: 0">
        <strong>{{ w.name }}</strong>
        <div class="muted" style="word-break: break-all">{{ w.root }}</div>
      </div>
      <el-tag :type="w.permissions.write ? 'warning' : 'info'">{{
        w.permissions.write ? '读写' : '只读'
      }}</el-tag>
      <el-select
        v-if="w.permissions.write && w.enabled"
        :model-value="w.writePolicy || 'approval'"
        style="width: 150px"
        aria-label="工作区写入策略"
        @change="(policy: 'auto' | 'approval') => changeWritePolicy(w, policy)"
      >
        <el-option label="逐次审批" value="approval" />
        <el-option label="自动写入" value="auto" />
      </el-select>
      <el-button text type="primary" @click="toggleWrite(w)">{{
        w.permissions.write ? '设为只读' : '开启写入'
      }}</el-button>
      <el-button text type="danger" :icon="Delete" @click="remove(w)" />
    </div>
  </div>
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
      description="添加后默认只允许列目录、搜索、读取文件与 Git 查询。写入权限可稍后单独开启。"
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
