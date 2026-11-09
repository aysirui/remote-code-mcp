<script setup lang="ts">
import {
  Monitor,
  FolderOpened,
  Connection,
  Plus,
  Refresh,
  Lock,
  Delete,
} from '@element-plus/icons-vue'
import { useRuntimeConsole } from './use-runtime-console'
const {
  browserWindow,
  token,
  status,
  workspaces,
  writeApprovals,
  gateway,
  setGatewayDraft,
  folder,
  folderName,
  showAdd,
  browse,
  pairing,
  code,
  refresh,
  answerWriteApproval,
  updateGateway,
  startPair,
  finishPair,
  openBrowse,
  pickDir,
  addWorkspace,
  toggleWrite,
  changeWritePolicy,
  remove,
  unpair,
} = useRuntimeConsole()
</script>
<template>
  <div class="layout">
    <header class="mast">
      <div>
        <div class="brand"><span class="mark">◈</span> Remote Code Runtime</div>
        <div class="muted" style="margin-left: 51px">本地工作区与 AI 执行权限管理</div>
      </div>
      <el-tag :type="status.online ? 'success' : 'info'" effect="light" size="large">{{
        !status.paired ? '○ 设备未绑定' : status.online ? '● Gateway 已连接' : '○ Gateway 未连接'
      }}</el-tag>
    </header>
    <el-alert
      v-if="!token"
      type="error"
      title="未授权访问"
      description="请使用 Runtime 启动终端中显示的本地管理 URL 打开本界面。"
      :closable="false"
    />
    <template v-else
      ><div v-if="writeApprovals.length" class="card">
        <div class="title">待审批的文件修改（30 秒后自动拒绝）</div>
        <el-alert
          title="远程 AI 请求修改本地文件"
          description="请核对工作区与文件路径；没有批准的请求不会执行。"
          type="warning"
          :closable="false"
          style="margin: 12px 0"
        />
        <div v-for="approval in writeApprovals" :key="approval.id" class="project row">
          <div style="flex: 1; min-width: 0; word-break: break-all">
            <strong>{{ approval.workspaceName }}</strong>
            <div>{{ approval.path }}</div>
            <div class="muted">{{ approval.bytes }} 字节待写入</div>
            <pre
              style="
                max-height: 160px;
                overflow: auto;
                white-space: pre-wrap;
                background: #f6f8fb;
                padding: 8px;
              "
              >{{ approval.preview }}</pre>
            <div v-if="approval.truncated" class="muted">仅展示前 2000 个字符，请谨慎确认</div>
          </div>
          <el-button type="danger" plain @click="answerWriteApproval(approval.id, false)"
            >拒绝</el-button
          >
          <el-button type="primary" @click="answerWriteApproval(approval.id, true)"
            >批准本次</el-button
          >
        </div>
      </div>
      <div class="card">
        <div class="row between">
          <div>
            <div class="title">设备与云端连接</div>
            <div class="muted">
              {{ status.name || '本地设备' }} · {{ status.deviceId || '尚未绑定账号' }}
            </div>
          </div>
          <el-button :icon="Refresh" @click="refresh">刷新</el-button>
        </div>
        <el-divider />
        <div class="row">
          <el-input
            :model-value="gateway"
            placeholder="https://mcp.example.com"
            @update:model-value="setGatewayDraft"
          /><el-button @click="updateGateway">设置服务器</el-button>
        </div>
        <div v-if="!status.paired" style="margin-top: 20px">
          <el-alert
            title="当前设备尚未绑定"
            type="info"
            :closable="false"
            description="点击生成配对码，随后在平台控制台登录账号并输入配对码。"
          /><el-button type="primary" style="margin-top: 16px" @click="startPair"
            ><el-icon><Connection /></el-icon> 绑定设备</el-button
          >
          <div
            v-if="pairing"
            style="margin-top: 19px; background: #f1f6ff; padding: 18px; border-radius: 10px"
          >
            <div class="muted">你的临时配对码</div>
            <div style="font-size: 28px; letter-spacing: 3px; font-weight: 750; margin: 8px 0">
              {{ pairing.code }}
            </div>
            <div class="row">
              <el-button
                type="primary"
                @click="browserWindow.open(pairing.activationUrl, '_blank', 'noopener')"
                >打开平台授权页面</el-button
              ><el-button @click="finishPair">我已确认，完成绑定</el-button>
            </div>
          </div>
        </div>
        <div v-else class="row" style="margin-top: 17px">
          <el-tag type="success">已绑定账户</el-tag
          ><el-button text type="danger" @click="unpair">断开本地连接</el-button>
        </div>
      </div>
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
      <div class="card">
        <div class="row">
          <el-icon color="#2563eb" size="22"><Lock /></el-icon>
          <div>
            <strong>安全提醒</strong>
            <div class="muted">
              保持 Runtime 以普通用户运行；不要将家目录或磁盘根目录作为工作区；不要把本地管理 URL
              中的 Token 发送给他人。
            </div>
          </div>
        </div>
      </div>
    </template>
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
          <el-empty
            v-if="!browse.entries.length"
            description="没有子目录" /></el-scrollbar></template
      ><template #footer
        ><el-button @click="browse = null">取消</el-button
        ><el-button type="primary" @click="pickDir">选择此目录</el-button></template
      ></el-dialog
    >
  </div>
</template>
