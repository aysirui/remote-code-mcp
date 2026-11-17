import { ref, onUnmounted, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ApiError, request, type User as Account } from '../api'
import { useRouter } from 'vue-router'

/** 认证表单及会话操作；登录成功后由 Console 刷新业务数据。 */
export function useAuth(
  me: Ref<Account | null>,
  refresh: () => Promise<void>,
  reportError: (error: unknown) => void,
) {
  const router = useRouter()
  const email = ref('')
  const password = ref('')
  const registering = ref(false)
  /** 重发请求进行中，避免重复提交。 */
  const resendBusy = ref(false)
  /** 距下一次允许重发的秒数，429 时以服务端剩余时间为准。 */
  const resendSeconds = ref(0)
  let resendTimer: ReturnType<typeof setInterval> | undefined
  /** 服务端冷却时间同步到按钮，卸载时释放计时器。 */
  function startCooldown(seconds: number) {
    clearInterval(resendTimer)
    resendSeconds.value = seconds
    resendTimer = setInterval(() => {
      if (--resendSeconds.value <= 0) clearInterval(resendTimer)
    }, 1000)
  }
  onUnmounted(() => clearInterval(resendTimer))
  /** 使用当前邮箱和密码重发激活邮件，失败时保留输入便于恢复。 */
  async function resendActivation() {
    if (resendBusy.value || resendSeconds.value) return
    resendBusy.value = true
    try {
      await request('/api/auth/resend-activation', 'POST', {
        email: email.value,
        password: password.value,
      })
      startCooldown(60)
      ElMessage.success('激活邮件已发送，请前往邮箱确认')
    } catch (error) {
      if (error instanceof ApiError && error.retryAfter) startCooldown(error.retryAfter)
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

  /** 处理注册与登录；首次管理员登录必须先完成临时密码修改。 */
  async function signIn() {
    try {
      if (registering.value) {
        await request('/api/auth/register', 'POST', {
          email: email.value,
          password: password.value,
        })
        ElMessage.success('账号已创建，请前往邮箱激活后再登录。')
        startCooldown(60)
        registering.value = false
        return
      }
      me.value = await request<Account>('/api/auth/login', 'POST', {
        email: email.value,
        password: password.value,
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
      if (error instanceof ApiError && error.code === 'ACCOUNT_ACTIVATION_SEND_FAILED') {
        registering.value = false
        startCooldown(error.retryAfter || 60)
      }
      reportError(error)
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
