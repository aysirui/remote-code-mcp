<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Monitor,
  FolderOpened,
  Connection,
  Plus,
  Refresh,
  Lock,
  Delete,
} from '@element-plus/icons-vue'
const browserWindow = window
const token = ref(sessionStorage.getItem('rcm_key') || ''),
  status = ref<any>({}),
  workspaces = ref<any[]>([]),
  writeApprovals = ref<Array<{
    id: string
    workspaceName: string
    path: string
    bytes: number
    preview: string
    truncated: boolean
    createdAt: number
  }>>([]),
  gateway = ref(''),
  folder = ref(''),
  folderName = ref(''),
  showAdd = ref(false),
  browse = ref<any>(null),
  pairing = ref<any>(null),
  code = ref('')
let timer: any
if (location.hash.includes('token=')) {
  const t = new URLSearchParams(location.hash.slice(1)).get('token')
  if (t) {
    token.value = t
    sessionStorage.setItem('rcm_key', t)
    history.replaceState(null, '', location.pathname)
  }
}
async function api(path: string, method = 'GET', data?: any) {
  const r = await fetch('/local/api/' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token.value, 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const x = await r.json()
  if (!r.ok) throw Error(x.error || 'Request failed')
  return x
}
async function refresh() {
  if (!token.value) return
  try {
    status.value = await api('status')
    workspaces.value = await api('workspaces')
    writeApprovals.value = await api('write-approvals')
    gateway.value = status.value.gateway
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}
async function answerWriteApproval(id: string, approve: boolean) {
  try {
    if (approve) {
      await ElMessageBox.confirm(
        '批准后，当前远程请求将修改所列文件。只批准你明确认识的请求。',
        '确认本地文件写入',
        { type: 'warning', confirmButtonText: '允许写入' },
      )
    }
    await api('write-approvals/' + encodeURIComponent(id), 'POST', { approve })
    await refresh()
    ElMessage.success(approve ? '已批准本次写入' : '已拒绝本次写入')
  } catch (e: any) {
    if (e !== 'cancel') ElMessage.error(e.message || '操作失败')
  }
}

async function updateGateway() {
  try {
    await ElMessageBox.confirm('更换服务地址会解绑当前设备，确定继续吗？', '切换 Gateway', {
      type: 'warning',
    })
    await api('config', 'POST', { gateway: gateway.value })
    await refresh()
    ElMessage.success('服务地址已更新')
  } catch (e: any) {
    if (e !== 'cancel') ElMessage.error(e.message)
  }
}
async function startPair() {
  try {
    pairing.value = await api('pair/start', 'POST')
    ElMessage.success('配对码已生成')
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}
async function finishPair() {
  if (!pairing.value) return
  try {
    const r = await api('pair/complete', 'POST', {
      id: pairing.value.id,
      privateSecret: pairing.value.privateSecret,
    })
    if (r.status === 'complete') {
      pairing.value = null
      ElMessage.success('设备绑定成功')
      await refresh()
    } else ElMessage.info('请先在平台输入配对码并确认绑定')
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}
async function openBrowse(p?: string) {
  try {
    browse.value = await api('browse' + (p ? '?path=' + encodeURIComponent(p) : ''))
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}
function pickDir() {
  if (!browse.value) return
  folder.value = browse.value.path
  browse.value = null
}
async function addWorkspace() {
  try {
    await api('workspaces', 'POST', { root: folder.value, name: folderName.value })
    showAdd.value = false
    folder.value = ''
    folderName.value = ''
    await refresh()
    ElMessage.success('工作区授权成功')
  } catch (e: any) {
    ElMessage.error(e.message)
  }
}
async function toggleWrite(w: any) {
  try {
    if (!w.permissions.write)
      await ElMessageBox.confirm(
        '允许 AI 修改这个项目的文件？仅对你明确授权的工作区开放。',
        '开启写入权限',
        { type: 'warning' },
      )
    await api('workspaces/' + w.id, 'PATCH', { write: !w.permissions.write })
    await refresh()
  } catch (e: any) {
    if (e !== 'cancel') ElMessage.error(e.message)
  }
}
async function remove(w: any) {
  try {
    await ElMessageBox.confirm('确认移除 ' + w.name + ' 的授权？', '移除工作区', {
      type: 'warning',
    })
    await api('workspaces/' + w.id, 'DELETE')
    await refresh()
  } catch {}
}
async function unpair() {
  try {
    await ElMessageBox.confirm(
      '本地将停止连接，若想完全撤销云端设备凭据，请同时在 Web Console 解绑。',
      '断开设备',
    )
    await api('unpair', 'POST')
    await refresh()
  } catch {}
}
onMounted(() => {
  refresh()
  timer = setInterval(refresh, 8000)
})
onUnmounted(() => clearInterval(timer))
</script>
<template>
  <div class="layout">
    <header class="mast">
      <div>
        <div class="brand"><span class="mark">◈</span> Remote Code Runtime</div>
        <div class="muted" style="margin-left: 51px">本地工作区与 AI 执行权限管理</div>
      </div>
      <el-tag :type="status.online ? 'success' : 'info'" effect="light" size="large">{{
        status.online ? '● Gateway 已连接' : '○ Gateway 未连接'
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
            <pre style="max-height: 160px; overflow: auto; white-space: pre-wrap; background: #f6f8fb; padding: 8px">{{ approval.preview }}</pre>
            <div v-if="approval.truncated" class="muted">仅展示前 2000 个字符，请谨慎确认</div>
          </div>
          <el-button type="danger" plain @click="answerWriteApproval(approval.id, false)">拒绝</el-button>
          <el-button type="primary" @click="answerWriteApproval(approval.id, true)">批准本次</el-button>
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
          <el-input v-model="gateway" placeholder="https://mcp.example.com" /><el-button
            @click="updateGateway"
            >设置服务器</el-button
          >
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
          }}</el-tag
          ><el-button text type="primary" @click="toggleWrite(w)">{{
            w.permissions.write ? '设为只读' : '开启写入'
          }}</el-button
          ><el-button text type="danger" :icon="Delete" @click="remove(w)" />
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
