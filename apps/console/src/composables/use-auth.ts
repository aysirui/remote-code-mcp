import { ref, watch, onUnmounted, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ApiError, request, type User as Account } from '../api'
import { useRoute, useRouter } from 'vue-router'

/** 认证表单及会话操作；登录成功后由 Console 刷新业务数据。 */
export function useAuth(
  me: Ref<Account | null>,
  refresh: () => Promise<void>,
  reportError: (error: unknown) => void,
) {
  const router = useRouter()
  const route = useRoute()
  const email = ref('')
  const password = ref('')
  const registering = ref(route.query.register === '1')
  /** 激活链接失效时可直接跳转至注册恢复入口，支持 SPA 内部导航。 */
  watch(
    () => route.query.register,
    (value) => {
      if (value === '1') registering.value = true
    },
  )
  /** 登录或注册请求进行中，整个认证表单禁止重复提交。 */
  const authBusy = ref(false)
  /** 仅在已有账号未激活或首次发送失败时展示邮件恢复弹窗。 */
  const activationDialogOpen = ref(false)
  /** 弹窗显示本次提交的邮箱，不随表单后续编辑改变。 */
  const activationEmail = ref('')
  // 重发始终使用触发弹窗时的凭据，不允许通过重复注册覆盖原账号密码。
  let activationCredentials: { email: string; password: string } | null = null
  /** 冷却属于单个邮箱，切换账号时不沿用其他邮箱的倒计时。 */
  let cooldownEmail = ''
  /** 打开未激活提示；邮件只在用户点击重发后发送。 */
  function showActivationPrompt(submittedEmail: string, submittedPassword: string) {
    if (cooldownEmail !== submittedEmail.trim().toLowerCase()) {
      clearInterval(resendTimer)
      resendSeconds.value = 0
    }
    activationCredentials = { email: submittedEmail.trim(), password: submittedPassword }
    activationEmail.value = submittedEmail.trim()
    activationDialogOpen.value = true
  }
  /** 弹窗关闭后释放暂存凭据，不清除用户仍在编辑的表单。 */
  function clearActivationPrompt() {
    if (activationDialogOpen.value) return
    activationCredentials = null
    activationEmail.value = ''
  }
  /** 重发请求进行中，避免重复提交。 */
  const resendBusy = ref(false)
  /** 距下一次允许重发的秒数，429 时以服务端剩余时间为准。 */
  const resendSeconds = ref(0)
  let resendTimer: ReturnType<typeof setInterval> | undefined
  /** 服务端冷却时间同步到按钮，卸载时释放计时器。 */
  function startCooldown(seconds: number, mailbox: string) {
    cooldownEmail = mailbox.trim().toLowerCase()
    clearInterval(resendTimer)
    resendSeconds.value = seconds
    resendTimer = setInterval(() => {
      if (--resendSeconds.value <= 0) clearInterval(resendTimer)
    }, 1000)
  }
  onUnmounted(() => clearInterval(resendTimer))
  /** 使用弹窗对应的原注册凭据重发；成功关闭弹窗，失败保留提示与冷却状态。 */
  async function resendActivation() {
    if (resendBusy.value || resendSeconds.value || !activationCredentials) return
    const credentials = activationCredentials
    resendBusy.value = true
    try {
      await request('/api/auth/resend-activation', 'POST', {
        ...credentials,
      })
      startCooldown(60, credentials.email)
      activationDialogOpen.value = false
      registering.value = false
      ElMessage.success('激活邮件已发送，请前往邮箱确认')
    } catch (error) {
      if (error instanceof ApiError && error.retryAfter)
        startCooldown(error.retryAfter, credentials.email)
      reportError(error)
    } finally {
      resendBusy.value = false
    }
  }
  const currentPassword = ref('')
  const newPassword = ref('')
  const newPasswordConfirm = ref('')
  const location = window.location
  const returnTo = new URLSearchParams(location.search).get('returnTo')

  /** 登录与注册均维护加载状态；未激活账号只弹出恢复提示，不自动发送或替换密码。 */
  async function signIn() {
    if (authBusy.value || resendBusy.value || activationDialogOpen.value) return
    const submittedEmail = email.value
    const submittedPassword = password.value
    authBusy.value = true
    try {
      if (registering.value) {
        await request('/api/auth/register', 'POST', {
          email: submittedEmail,
          password: submittedPassword,
        })
        ElMessage.success('账号已创建，请前往邮箱激活后再登录。')
        startCooldown(60, submittedEmail)
        registering.value = false
        return
      }
      me.value = await request<Account>('/api/auth/login', 'POST', {
        email: submittedEmail,
        password: submittedPassword,
      })
      if (me.value?.passwordChangeRequired) {
        currentPassword.value = password.value
        password.value = ''
        ElMessage.warning('首次登录请先修改临时密码')
        return
      }
      if (returnTo) {
        const target = new URL(returnTo)
        const allow = new URL(import.meta.env.VITE_API_URL || location.origin)
        if (target.origin === allow.origin) {
          location.href = target.toString()
          return
        }
      }
      await refresh()
      ElMessage.success('登录成功')
    } catch (error: unknown) {
      if (error instanceof ApiError && error.code === 'EMAIL_NOT_VERIFIED') {
        showActivationPrompt(submittedEmail, submittedPassword)
        return
      }
      if (error instanceof ApiError && error.code === 'ACCOUNT_ACTIVATION_SEND_FAILED') {
        startCooldown(error.retryAfter || 60, submittedEmail)
        showActivationPrompt(submittedEmail, submittedPassword)
      }
      reportError(error)
    } finally {
      authBusy.value = false
    }
  }

  /** 校验新密码确认值后提交修改；成功后要求用户使用新密码重新登录。 */
  async function changePassword() {
    if (!currentPassword.value || !newPassword.value) {
      ElMessage.warning('请输入旧密码和新密码')
      return
    }
    if (newPassword.value !== newPasswordConfirm.value) {
      ElMessage.error('两次输入的新密码不一致')
      return
    }
    try {
      await request('/api/auth/change-password', 'POST', {
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
      })
      currentPassword.value = ''
      newPassword.value = ''
      newPasswordConfirm.value = ''
      me.value = null
      password.value = ''
      ElMessage.success('密码修改成功，请使用新密码重新登录')
    } catch (error: unknown) {
      reportError(error)
    }
  }

  /** 注销当前 Session 并返回 Console 入口。 */
  async function logout() {
    await request('/api/auth/logout', 'POST')
    me.value = null
    await router.push('/console')
  }

  return {
    authBusy,
    activationDialogOpen,
    activationEmail,
    clearActivationPrompt,
    resendBusy,
    resendSeconds,
    resendActivation,
    email,
    password,
    registering,
    currentPassword,
    newPassword,
    newPasswordConfirm,
    signIn,
    changePassword,
    logout,
  }
}
