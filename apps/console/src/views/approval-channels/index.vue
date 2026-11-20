<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch } from 'vue'
import { Bell, CopyDocument } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { toDataURL } from 'qrcode'
import { request } from '../../api'
import {
  approvalChannelsEndpoint,
  type ApprovalChannel,
} from '../../composables/use-approval-channels'
import type { ConsoleContext } from '../../composables/use-console'

/** 渠道名称、本地品牌图标和打开私聊前的必要条件。 */
const profiles = {
  feishu: { name: '飞书', logo: 'feishu.png', hint: '外部用户需先申请使用并开启机器人私聊。' },
  wecom: { name: '企业微信', logo: 'wecom.png', hint: '使用所在企业开放给你的智能机器人。' },
  dingtalk: { name: '钉钉', logo: 'dingtalk.png', hint: '使用部署方所在企业已发布的应用机器人。' },
}
/** 区分平台授权条件和 RCM 绑定，避免让用户误以为扫码即订阅。 */
const accessSteps = {
  feishu: {
    scan: '用飞书扫一扫打开 RCM 机器人。外部用户请按提示申请使用并开启单聊；如需审核，等通过后再继续。',
    manual: '在飞书中搜索对你可见的 RCM 机器人，打开私聊。',
  },
  wecom: {
    scan: '用企业微信扫一扫打开机器人入口，再进入与 RCM 智能机器人的私聊。请使用对该机器人有使用权限的企业账号。',
    manual:
      '在企业微信中打开部署方提供的 RCM 智能机器人私聊。如找不到，请确认当前企业和机器人可用范围。',
  },
  dingtalk: {
    scan: '用钉钉扫一扫打开机器人入口，再进入与 RCM 应用机器人的私聊。请切换到应用所属组织。',
    manual: '在钉钉切换到应用所属组织，搜索机器人名称，在「功能」结果中打开私聊。',
  },
}
const logoBase = import.meta.env.BASE_URL + 'channel-logos/'

/** 绑定指令和确认码共用同一个截止时间。 */
type Challenge = { botLink?: string; message: string; expiresAt: string }
const { channels, loading, error, reload } = inject<ConsoleContext>('console')!.approvalChannels
const selected = ref<ApprovalChannel['channel']>()
const profile = computed(() => (selected.value ? profiles[selected.value] : undefined))
const dialog = ref(false)
const challenge = ref<Challenge>()
const shareLink = computed(() => challenge.value?.botLink)
const qrCode = ref('')
const qrFailed = ref(false)
const showShareLink = ref(false)
const confirmation = ref('')
const dialogError = ref('')
const bindingBusy = ref(false)
const pendingChannel = ref<ApprovalChannel['channel']>()
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
let disposed = false
const remaining = computed(() =>
  challenge.value
    ? Math.max(0, Math.ceil((Date.parse(challenge.value.expiresAt) - now.value) / 1000))
    : 0,
)
const expiry = computed(
  () => `${Math.floor(remaining.value / 60)}:${String(remaining.value % 60).padStart(2, '0')}`,
)
const enabledCount = computed(() => channels.value.filter((channel) => channel.enabled).length)

/** 在浏览器内生成二维码，仅编码分享链接，不包含绑定指令或确认码。 */
watch(shareLink, async (link, _previous, onCleanup) => {
  qrCode.value = ''
  qrFailed.value = false
  showShareLink.value = false
  if (!link) return
  let active = true
  onCleanup(() => {
    active = false
  })
  try {
    const image = await toDataURL(link, { width: 288, margin: 4 })
    if (active) qrCode.value = image
  } catch {
    if (active) qrFailed.value = true
  }
})

/** 只在绑定弹窗打开时维护倒计时。 */
function stopClock() {
  clearInterval(clock)
  clock = undefined
}
onUnmounted(() => {
  disposed = true
  stopClock()
})

/** 打开指定渠道的绑定窗口，并获取一次性指令。 */
function openBinding(channel: ApprovalChannel['channel']) {
  selected.value = channel
  dialog.value = true
  void generate()
}

/** 旧指令失效时重新生成，避免提交上一轮的确认码。 */
async function generate() {
  if (!selected.value || bindingBusy.value) return
  stopClock()
  bindingBusy.value = true
  challenge.value = undefined
  confirmation.value = ''
  dialogError.value = ''
  try {
    const result = await request<Challenge>(approvalChannelsEndpoint + '/' + selected.value, 'POST')
    if (disposed) return
    challenge.value = result
    now.value = Date.now()
    clock = setInterval(() => {
      now.value = Date.now()
      if (!remaining.value) stopClock()
    }, 1000)
  } catch (failure) {
    dialogError.value = failure instanceof Error ? failure.message : '无法生成绑定指令，请重试'
  } finally {
    bindingBusy.value = false
  }
}

/** 将机器人回复的确认码提交给当前账号；成功后刷新渠道状态。 */
async function confirm() {
  if (
    !selected.value ||
    !remaining.value ||
    !/^[a-f0-9]{32}$/.test(confirmation.value) ||
    bindingBusy.value
  )
    return
  bindingBusy.value = true
  dialogError.value = ''
  try {
    await request(approvalChannelsEndpoint + '/' + selected.value + '/confirm', 'POST', {
      confirmation: confirmation.value,
    })
    dialog.value = false
    ElMessage.success('绑定成功，已开启审批通知')
    await reload()
  } catch (failure) {
    dialogError.value = failure instanceof Error ? failure.message : '绑定失败，请重试'
  } finally {
    bindingBusy.value = false
  }
}

/** 关闭弹窗后清除临时信息，不在页面保留绑定指令或确认码。 */
function resetDialog() {
  stopClock()
  challenge.value = undefined
  confirmation.value = ''
  dialogError.value = ''
}

/** 复制失败时保留只读输入框供手动复制。 */
async function copyCode() {
  if (!challenge.value || !remaining.value) return
  try {
    await navigator.clipboard.writeText(challenge.value.message)
    ElMessage.success('已复制完整指令，请直接粘贴到机器人私聊并发送')
  } catch {
    ElMessage.warning('无法访问剪贴板，请手动复制输入框中的整行指令')
  }
}

/** 复制机器人分享链接；浏览器限制剪贴板时显示原链接供手动复制。 */
async function copyShareLink() {
  if (!shareLink.value) return
  try {
    await navigator.clipboard.writeText(shareLink.value)
    ElMessage.success('机器人链接已复制')
  } catch {
    showShareLink.value = true
    ElMessage.warning('无法访问剪贴板，请手动复制机器人链接')
  }
}

/** 独立开启、暂停或解绑渠道；服务端确认后才刷新状态。 */
async function update(channel: ApprovalChannel, enabled?: unknown) {
  if (pendingChannel.value || (enabled !== undefined && typeof enabled !== 'boolean')) return
  pendingChannel.value = channel.channel
  try {
    const endpoint = approvalChannelsEndpoint + '/' + channel.channel
    if (enabled === undefined) {
      await request(endpoint, 'DELETE')
      channel.bound = false
      channel.enabled = false
    } else {
      await request(endpoint, 'PATCH', { enabled })
      channel.enabled = enabled
    }
    ElMessage.success(
      enabled === undefined ? '已解除绑定' : enabled ? '已开启审批通知' : '已暂停审批通知',
    )
    await reload()
  } catch (failure) {
    ElMessage.error(failure instanceof Error ? failure.message : '更新渠道失败，请重试')
  } finally {
    pendingChannel.value = undefined
  }
}

/** 沿用控制台的居中确认框，明确提示解绑只影响当前渠道。 */
async function confirmUnbind(channel: ApprovalChannel) {
  const name = profiles[channel.channel].name
  try {
    await ElMessageBox.confirm(
      `解除后，${name}将不再接收审批通知，已发送的卡片也不能再审批。其他渠道和 Runtime 不受影响。`,
      `解除${name}绑定？`,
      {
        type: 'warning',
        confirmButtonText: '解除绑定',
        confirmButtonType: 'danger',
        cancelButtonText: '取消',
        autofocus: false,
        closeOnClickModal: false,
      },
    )
  } catch (failure) {
    if (failure !== 'cancel' && failure !== 'close') ElMessage.error('暂时无法打开确认框，请重试')
    return
  }
  await update(channel)
}
</script>

<template>
  <section
    v-if="loading && !channels.length"
    class="card"
    aria-label="正在加载通知渠道"
    aria-busy="true">
    <el-skeleton :rows="3" animated />
  </section>
  <section v-else-if="!channels.length" class="card" aria-labelledby="channel-empty-title">
    <el-empty :image-size="96" description="">
      <h2 id="channel-empty-title">
        {{ error ? '暂时无法加载通知渠道' : '暂不支持通知渠道绑定' }}
      </h2>
      <p>{{ error || '服务器尚未配置通知渠道应用。你仍可以在 Runtime 内查看和处理审批。' }}</p>
      <el-button v-if="error" type="primary" @click="reload">重新加载</el-button>
    </el-empty>
  </section>
  <template v-else>
    <section class="card" aria-labelledby="channel-list-title" :aria-busy="loading">
      <div class="channel-heading">
        <div>
          <h2 id="channel-list-title" class="card-title">接收渠道</h2>
          <p>可同时开启多个渠道。同一请求以第一个有效决定为准。</p>
        </div>
        <el-tag effect="plain">{{ enabledCount }} 个已开启</el-tag>
      </div>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <ul class="channel-list">
        <li v-for="item in channels" :key="item.channel" class="channel-row">
          <span class="channel-icon" aria-hidden="true">
            <img :src="logoBase + profiles[item.channel].logo" width="28" height="28" alt="" />
          </span>
          <div class="channel-copy">
            <div class="channel-name">
              <strong>{{ profiles[item.channel].name }}</strong>
              <el-tag size="small" effect="plain" :type="item.enabled ? 'success' : 'info'">
                {{ !item.bound ? '未绑定' : item.enabled ? '接收中' : '已暂停' }}
              </el-tag>
            </div>
            <p>{{ profiles[item.channel].hint }}</p>
          </div>
          <div class="channel-actions">
            <template v-if="item.bound">
              <el-switch
                :model-value="item.enabled"
                :aria-label="profiles[item.channel].name + '接收通知'"
                :loading="pendingChannel === item.channel"
                :disabled="loading || !!pendingChannel"
                @change="update(item, $event)" />
              <el-button text :disabled="loading || !!pendingChannel" @click="confirmUnbind(item)">
                解除绑定
              </el-button>
            </template>
            <el-button
              v-else
              type="primary"
              plain
              :disabled="loading || !!pendingChannel"
              @click="openBinding(item.channel)">
              绑定{{ profiles[item.channel].name }}
            </el-button>
          </div>
        </li>
      </ul>
    </section>
    <aside class="channel-note">
      <el-icon aria-hidden="true"><Bell /></el-icon>
      <span>审批通知会发送完整命令和操作说明，消息可能被渠道平台留存。</span>
    </aside>
  </template>

  <el-dialog
    v-model="dialog"
    :title="'绑定' + (profile?.name || '通知渠道')"
    width="min(560px, calc(100vw - 32px))"
    :close-on-click-modal="false"
    :close-on-press-escape="!bindingBusy"
    :show-close="!bindingBusy"
    align-center
    @close="resetDialog">
    <el-alert v-if="dialogError" :title="dialogError" type="error" :closable="false" show-icon />
    <el-skeleton v-if="bindingBusy && !challenge" :rows="3" animated />
    <ol v-if="challenge && selected" class="binding-steps">
      <li class="binding-step">
        <span class="step-number" aria-hidden="true">1</span>
        <div class="step-content">
          <h3>打开机器人私聊</h3>
          <div class="robot-access">
            <img
              v-if="qrCode"
              :src="qrCode"
              width="128"
              height="128"
              :alt="profile?.name + '机器人分享二维码'" />
            <div class="robot-access-actions">
              <p>{{ shareLink ? accessSteps[selected].scan : accessSteps[selected].manual }}</p>
              <p v-if="qrFailed" role="status">二维码暂不可用，可直接打开或复制链接。</p>
              <div v-if="shareLink" class="robot-links">
                <el-link :href="shareLink" type="primary" target="_blank" rel="noopener noreferrer">
                  打开机器人
                </el-link>
                <el-button text :icon="CopyDocument" @click="copyShareLink">复制链接</el-button>
              </div>
              <el-input
                v-if="showShareLink"
                :model-value="shareLink"
                aria-label="机器人分享链接"
                readonly />
            </div>
          </div>
        </div>
      </li>
      <li class="binding-step">
        <span class="step-number" aria-hidden="true">2</span>
        <div class="step-content">
          <div class="step-heading">
            <h3>发送绑定指令</h3>
            <span class="binding-expiry" :class="{ 'is-expired': !remaining }">
              {{ remaining ? '剩余 ' + expiry : '指令已过期' }}
            </span>
          </div>
          <div class="copy-row">
            <el-input
              :model-value="challenge.message"
              aria-label="完整绑定指令"
              aria-describedby="binding-command-help"
              readonly />
            <el-button :icon="CopyDocument" :disabled="!remaining" @click="copyCode">
              复制完整指令
            </el-button>
          </div>
          <p id="binding-command-help">
            在私聊粘贴并发送整行，保留「绑定」和后面的空格。只发绑定码不会触发回复。
          </p>
        </div>
      </li>
      <li class="binding-step">
        <span class="step-number" aria-hidden="true">3</span>
        <div class="step-content">
          <h3>填写机器人回复的确认码</h3>
          <el-form
            id="approval-channel-confirm"
            aria-label="确认渠道绑定"
            @submit.prevent="confirm">
            <el-input
              v-model.trim="confirmation"
              aria-label="机器人确认码"
              placeholder="粘贴 32 位确认码"
              maxlength="32"
              autocomplete="off"
              :disabled="!remaining || bindingBusy" />
          </el-form>
          <p>确认码不是上一步的绑定指令。确认后开启审批通知。</p>
        </div>
      </li>
    </ol>
    <template #footer>
      <el-button :disabled="bindingBusy" @click="dialog = false">取消</el-button>
      <el-button v-if="!remaining" type="primary" :loading="bindingBusy" @click="generate">
        {{ challenge ? '重新生成指令' : '获取指令' }}
      </el-button>
      <el-button
        v-else
        form="approval-channel-confirm"
        type="primary"
        native-type="submit"
        :loading="bindingBusy"
        :disabled="!/^[a-f0-9]{32}$/.test(confirmation)">
        确认绑定
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.channel-heading,
.channel-row,
.channel-actions,
.channel-name,
.channel-note,
.copy-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.channel-heading {
  justify-content: space-between;
  flex-wrap: wrap;
  padding-bottom: 12px;
}
.channel-heading p,
.channel-copy p,
.binding-steps p {
  margin: 4px 0;
  color: var(--ui-muted, #526074);
  line-height: 1.55;
  font-size: 13px;
}
.channel-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.channel-row {
  border-top: 1px solid var(--ui-line, #e2e8f0);
  padding: 16px 0;
}
.channel-icon {
  display: grid;
  place-items: center;
  flex: 0 0 40px;
  height: 40px;
  border-radius: 8px;
  background: #fff;
  border: 1px solid var(--ui-line, #e2e8f0);
}
.channel-icon img {
  display: block;
  object-fit: contain;
}
.channel-copy {
  flex: 1;
  min-width: 0;
}
.channel-name {
  flex-wrap: wrap;
  gap: 8px;
}
.channel-actions {
  flex-shrink: 0;
}
.channel-note {
  align-items: flex-start;
  padding: 0 4px;
  color: var(--ui-muted, #526074);
  line-height: 1.55;
  margin-top: 5px;
}
.channel-note .el-icon {
  flex: none;
  margin-top: 3px;
}
.binding-steps {
  margin: 0;
  padding: 0;
  list-style: none;
}
.binding-step {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 12px;
  padding: 14px 0;
}
.binding-step + .binding-step {
  border-top: 1px solid var(--ui-line, #e2e8f0);
}
.step-number {
  display: grid;
  place-items: center;
  height: 24px;
  border-radius: 50%;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 12px;
  font-weight: 600;
}
.step-content h3 {
  margin: 0;
  color: var(--ui-ink, #111827);
  font-size: 15px;
  line-height: 24px;
}
.step-heading,
.robot-links {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
}
.robot-links {
  justify-content: flex-start;
}
.binding-expiry {
  color: var(--ui-muted, #526074);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.binding-expiry.is-expired {
  color: var(--el-color-danger-dark-2);
}
.copy-row {
  margin-top: 8px;
  gap: 8px;
}
.copy-row :deep(.el-input__inner) {
  font-family: ui-monospace, monospace;
}
.binding-steps .el-form {
  margin-top: 8px;
  padding: 10px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}
.copy-row .el-input {
  min-width: 0;
}
.robot-access {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  margin-top: 8px;
}
.robot-access img {
  display: block;
  border: 1px solid var(--ui-line, #e2e8f0);
  border-radius: 8px;
  background: #fff;
}
.robot-access-actions {
  display: grid;
  justify-items: start;
  gap: 8px;
  flex: 1 1 148px;
  min-width: 0;
}
@media (max-width: 600px) {
  .channel-row {
    flex-wrap: wrap;
  }
  .channel-actions {
    flex: 1 0 100%;
    justify-content: flex-end;
  }
}
@media (max-width: 420px) {
  .copy-row {
    flex-wrap: wrap;
  }
  .copy-row .el-input {
    flex-basis: 100%;
  }
}
</style>
