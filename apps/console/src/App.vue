<script setup lang="ts">
import {
  Monitor,
  FolderOpened,
  Connection,
  DataAnalysis,
  User,
  Setting,
  Warning,
  Refresh,
  Lock,
  CopyDocument,
  Plus,
  SwitchButton,
} from '@element-plus/icons-vue'
import { useConsole } from './use-console'
const {
  me,
  loading,
  page,
  email,
  password,
  registering,
  devices,
  workspaces,
  users,
  logs,
  adminDevices,
  adminLogs,
  stats,
  grants,
  pairingCode,
  currentPassword,
  newPassword,
  newPasswordConfirm,
  isAdmin,
  title,
  mcpUrl,
  load,
  refresh,
  signIn,
  changePassword,
  logout,
  rename,
  revoke,
  approve,
  revokeGrant,
  disableWorkspace,
  adminRevoke,
  setUserStatus,
  navigate,
  copyUrl,
} = useConsole()
</script>
<template>
  <div v-if="loading" style="padding: 60px; text-align: center">
    <el-icon class="is-loading" size="30"><Refresh /></el-icon>
  </div>
  <div v-else-if="!me" class="auth-page">
    <div class="auth-art">
      <div style="font-size: 22px; font-weight: 700">◈ Remote Code MCP</div>
      <h1>让 AI 安全连接你的本地开发环境。</h1>
      <p>统一管理设备、工作区和 AI 授权。代码保留在你的电脑上，访问权限由你掌控。</p>
    </div>
    <div class="auth-form">
      <div class="auth-box">
        <div class="muted">REMOTE CODE PLATFORM</div>
        <h2>{{ registering ? '创建账号' : '欢迎回来' }}</h2>
        <p class="muted" style="margin-bottom: 30px">
          {{ registering ? '创建账号，开始连接本地设备' : '登录以管理你的设备与工作区' }}
        </p>
        <el-form @submit.prevent="signIn"
          ><el-form-item label="电子邮箱"
            ><el-input
              v-model="email"
              size="large"
              placeholder="you@example.com"
              autocomplete="username" /></el-form-item
          ><el-form-item label="密码（至少 12 位）"
            ><el-input
              v-model="password"
              type="password"
              size="large"
              show-password
              autocomplete="current-password"
              @keyup.enter="signIn" /></el-form-item
          ><el-button type="primary" size="large" @click="signIn">{{
            registering ? '注册账号' : '登录'
          }}</el-button></el-form
        >
        <div style="margin-top: 22px; text-align: center">
          <el-link type="primary" @click="registering = !registering">{{
            registering ? '已有账号？立即登录' : '没有账号？免费注册'
          }}</el-link>
        </div>
      </div>
    </div>
  </div>
  <div v-else-if="me.passwordChangeRequired" class="auth-page">
    <div class="auth-art">
      <h1>首次登录需要修改密码</h1>
      <p>初始化密码仅允许用于首次登录，修改成功后需要重新登录。</p>
    </div>
    <div class="auth-form">
      <div class="auth-box">
        <h2>设置新密码</h2>
        <p class="muted">{{ me.email }}</p>
        <el-form @submit.prevent="changePassword">
          <el-form-item label="当前临时密码">
            <el-input
              v-model="currentPassword"
              type="password"
              show-password
              autocomplete="current-password"
            />
          </el-form-item>
          <el-form-item label="新密码（12–72 UTF-8 字节）">
            <el-input
              v-model="newPassword"
              type="password"
              show-password
              autocomplete="new-password"
            />
          </el-form-item>
          <el-form-item label="再次输入新密码">
            <el-input
              v-model="newPasswordConfirm"
              type="password"
              show-password
              autocomplete="new-password"
              @keyup.enter="changePassword"
            />
          </el-form-item>
          <el-button type="primary" @click="changePassword">确认修改密码</el-button>
          <el-button @click="logout">退出登录</el-button>
        </el-form>
      </div>
    </div>
  </div>
  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">◈</span><span class="brand-text">Remote Code MCP</span>
      </div>
      <nav class="nav">
        <a
          v-for="item in [
            { id: 'overview', name: '工作台概览', icon: DataAnalysis },
            { id: 'devices', name: '我的设备', icon: Monitor },
            { id: 'workspaces', name: '工作区', icon: FolderOpened },
            { id: 'connections', name: 'AI 连接', icon: Connection },
            { id: 'history', name: '操作记录', icon: Warning },
          ]"
          :key="item.id"
          href="#"
          :class="{ active: page === item.id }"
          @click.prevent="navigate(item.id)"
          ><el-icon><component :is="item.icon" /></el-icon
          ><span class="label">{{ item.name }}</span></a
        >
        <div
          v-if="isAdmin"
          style="padding: 22px 13px 9px; color: #7285a0; font-size: 11px; font-weight: 700"
        >
          ADMINISTRATION
        </div>
        <a
          v-for="item in isAdmin
            ? [
                { id: 'admin-overview', name: '平台概览', icon: DataAnalysis },
                { id: 'admin-users', name: '用户管理', icon: User },
                { id: 'admin-devices', name: '平台设备', icon: Monitor },
                { id: 'admin-audit', name: '安全审计', icon: Lock },
              ]
            : []"
          :key="item.id"
          href="#"
          :class="{ active: page === item.id }"
          @click.prevent="navigate(item.id)"
          ><el-icon><component :is="item.icon" /></el-icon
          ><span class="label">{{ item.name }}</span></a
        >
      </nav>
      <div class="sidebar-footer">v0.1.0 · Secure by default</div>
    </aside>
    <div class="content">
      <header class="topbar">
        <div class="muted">工作空间 / {{ title }}</div>
        <div style="display: flex; align-items: center; gap: 12px">
          <span class="muted">{{ me.email }}</span
          ><el-button text @click="logout"
            ><el-icon><SwitchButton /></el-icon> 退出</el-button
          >
        </div>
      </header>
      <main class="page">
        <div class="pagehead">
          <div>
            <h1>{{ title }}</h1>
            <div class="muted">统一管理你的本地设备与 AI 工具授权</div>
          </div>
          <el-button :icon="Refresh" @click="refresh">刷新</el-button>
        </div>
        <template v-if="page === 'overview'"
          ><div class="stat-grid">
            <div
              v-for="s in [
                { label: '我的设备', value: devices.length },
                { label: '在线设备', value: devices.filter((d) => d.online).length },
                { label: '已授权工作区', value: workspaces.length },
              ]"
              :key="s.label"
              class="card"
            >
              <div class="stat-label">{{ s.label }}</div>
              <div class="stat-number">{{ s.value }}</div>
            </div>
          </div>
          <div class="notice">
            <strong>连接你的开发环境</strong><br />安装 Runtime，完成设备绑定和工作区授权，然后在
            ChatGPT 中添加 MCP Server URL。云端默认不持久化源码内容。
          </div>
          <div class="card">
            <div class="row-between">
              <h3 class="card-title">最近设备</h3>
              <el-button text type="primary" @click="navigate('devices')">查看全部</el-button>
            </div>
            <div v-for="d in devices" :key="d.id" class="device-row">
              <div class="device-icon">
                <el-icon><Monitor /></el-icon>
              </div>
              <div>
                <strong>{{ d.name }}</strong>
                <div class="muted">{{ d.platform }}</div>
              </div>
              <div class="spacer"></div>
              <el-tag :type="d.online ? 'success' : 'info'">{{
                d.online ? '在线' : '离线'
              }}</el-tag>
            </div>
            <el-empty v-if="!devices.length" description="暂无设备，先安装并绑定 Runtime" /></div
        ></template>
        <template v-else-if="page === 'devices'"
          ><div class="card">
            <div class="row-between">
              <h3 class="card-title">我的设备</h3>
              <el-button type="primary" @click="navigate('activate')"
                ><el-icon><Plus /></el-icon> 绑定设备</el-button
              >
            </div>
            <div v-for="d in devices" :key="d.id" class="device-row">
              <div class="device-icon">
                <el-icon><Monitor /></el-icon>
              </div>
              <div>
                <strong>{{ d.name }}</strong>
                <div class="muted">
                  {{ d.platform }} · {{ d.runtimeVersion || '未知版本' }} ·
                  {{
                    d.lastSeenAt
                      ? '最近连接 ' + new Date(d.lastSeenAt).toLocaleString()
                      : '暂无连接记录'
                  }}
                </div>
              </div>
              <div class="spacer"></div>
              <el-tag :type="d.online ? 'success' : 'info'">{{ d.online ? '在线' : '离线' }}</el-tag
              ><el-button text @click="rename(d)">重命名</el-button
              ><el-button text type="danger" @click="revoke(d)">解绑</el-button>
            </div>
            <el-empty v-if="!devices.length" description="还没有绑定设备" /></div
        ></template>
        <template v-else-if="page === 'activate'"
          ><div class="card" style="max-width: 660px">
            <h3 class="card-title">将 Runtime 绑定到你的账号</h3>
            <el-steps :active="1" finish-status="success" style="margin: 25px 0 34px"
              ><el-step title="打开 Runtime" /><el-step title="输入配对码" /><el-step
                title="绑定成功"
            /></el-steps>
            <p class="muted">
              请在本地 Runtime 页面点击“绑定设备”，获取一次性配对码，再输入下方。配对码仅短时有效。
            </p>
            <el-input
              v-model="pairingCode"
              placeholder="ABCD-EFGH"
              size="large"
              style="margin: 17px 0"
            /><el-button type="primary" :disabled="!pairingCode" @click="approve"
              >确认绑定</el-button
            >
          </div></template
        >
        <template v-else-if="page === 'workspaces'"
          ><div class="notice">
            工作区只能通过对应设备上的 Runtime 本地界面添加。云端只展示授权元数据，不保存绝对路径。
          </div>
          <div class="card table-wrap">
            <el-table :data="workspaces" style="width: 100%"
              ><el-table-column prop="name" label="工作区" min-width="170" /><el-table-column
                prop="deviceId"
                label="所属设备 ID"
                min-width="230"
              /><el-table-column label="权限" width="120"
                ><template #default="{ row }"
                  ><el-tag :type="row.write ? 'warning' : 'info'">{{
                    row.write ? '读写' : '只读'
                  }}</el-tag></template
                ></el-table-column
              ><el-table-column label="状态" width="100"
                ><template #default="{ row }"
                  ><el-tag :type="row.enabled ? 'success' : 'info'">{{
                    row.enabled ? '启用' : '停用'
                  }}</el-tag></template
                ></el-table-column
              ><el-table-column label="操作" width="120"
                ><template #default="{ row }"
                  ><el-button
                    text
                    type="danger"
                    :disabled="!row.enabled"
                    @click="disableWorkspace(row)"
                    >停用</el-button
                  ></template
                ></el-table-column
              ></el-table
            ><el-empty v-if="!workspaces.length" description="请在本地 Runtime 添加一个项目" /></div
        ></template>
        <template v-else-if="page === 'connections'"
          ><div class="card" style="max-width: 780px">
            <h3 class="card-title">ChatGPT MCP 连接</h3>
            <p class="muted">
              在 ChatGPT 插件管理页面创建自定义 MCP Server，填写下面的 URL，并使用当前账号完成 OAuth
              授权。
            </p>
            <div style="display: flex; gap: 10px; margin-top: 20px">
              <el-input readonly :model-value="mcpUrl" /><el-button
                type="primary"
                :icon="CopyDocument"
                @click="copyUrl"
                >复制 URL</el-button
              >
            </div>
            <el-divider />
            <h3 class="card-title">已授权的 AI 客户端</h3>
            <div v-for="g in grants" :key="g.clientId" class="device-row">
              <div style="flex: 1">
                <strong>{{ g.clientId }}</strong>
                <div class="muted">
                  {{ g.scope }} · {{ new Date(g.expiresAt).toLocaleString() }} 过期
                </div>
              </div>
              <el-button type="danger" text @click="revokeGrant(g)">撤销</el-button>
            </div>
            <el-empty
              v-if="!grants.length"
              description="暂无有效 OAuth 授权"
            /><el-divider /><el-alert
              type="info"
              :closable="false"
              title="授权说明"
              description="ChatGPT 只能操作你当前账号下的设备和工作区。文件写入仍受本地 Runtime 权限约束。"
            /></div
        ></template>
        <template v-else-if="page === 'history'"
          ><div class="card">
            <el-table :data="logs"
              ><el-table-column prop="operation" label="操作" /><el-table-column
                prop="status"
                label="结果"
              /><el-table-column prop="workspaceId" label="工作区" /><el-table-column label="时间"
                ><template #default="{ row }">{{
                  new Date(row.createdAt).toLocaleString()
                }}</template></el-table-column
              ></el-table
            ><el-empty v-if="!logs.length" description="暂无操作记录" /></div
        ></template>
        <template v-else-if="page === 'admin-overview'"
          ><div class="stat-grid">
            <div
              v-for="s in [
                { label: '注册用户', value: stats.users },
                { label: '总设备 / 在线', value: stats.devices + ' / ' + stats.online },
                { label: '工作区总数', value: stats.workspaces },
              ]"
              :key="s.label"
              class="card"
            >
              <div class="stat-label">{{ s.label }}</div>
              <div class="stat-number">{{ s.value }}</div>
            </div>
          </div>
          <div class="notice">
            管理员可以管理用户、设备与平台状态，但无法直接读取普通用户的本地源码内容。
          </div></template
        >
        <template v-else-if="page === 'admin-users'"
          ><div class="card">
            <el-table :data="users"
              ><el-table-column prop="email" label="用户邮箱" min-width="230" /><el-table-column
                prop="role"
                label="角色"
              /><el-table-column prop="status" label="状态" /><el-table-column label="操作"
                ><template #default="{ row }"
                  ><el-button
                    text
                    :type="row.status === 'active' ? 'danger' : 'primary'"
                    :disabled="row.id === me?.id || row.role === 'super_admin'"
                    @click="setUserStatus(row)"
                    >{{ row.status === 'active' ? '禁用' : '启用' }}</el-button
                  ></template
                ></el-table-column
              ></el-table
            >
          </div></template
        >
        <template v-else-if="page === 'admin-devices'"
          ><div class="card">
            <el-table :data="adminDevices"
              ><el-table-column prop="name" label="平台设备" /><el-table-column
                prop="userId"
                label="用户 ID"
                min-width="200"
              /><el-table-column prop="status" label="状态" /><el-table-column
                prop="platform"
                label="平台"
              /><el-table-column label="操作"
                ><template #default="{ row }"
                  ><el-button
                    text
                    type="danger"
                    :disabled="row.status === 'revoked'"
                    @click="adminRevoke(row)"
                    >撤销设备</el-button
                  ></template
                ></el-table-column
              ></el-table
            >
            <div class="muted" style="margin-top: 15px">
              平台全量设备列表；后续可补充筛选与分页。
            </div>
          </div></template
        >
        <template v-else-if="page === 'admin-audit'"
          ><div class="card">
            <el-table :data="adminLogs"
              ><el-table-column prop="operation" label="操作" /><el-table-column
                prop="status"
                label="结果" /><el-table-column prop="createdAt" label="时间"
            /></el-table></div
        ></template>
      </main>
    </div>
  </div>
</template>
