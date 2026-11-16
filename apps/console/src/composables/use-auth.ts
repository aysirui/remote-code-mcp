import { ref, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { request, type User as Account } from '../api'
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
        ElMessage.success('注册成功，请登录')
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
