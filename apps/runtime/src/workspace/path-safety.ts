import fs from 'node:fs/promises'
import path from 'node:path'
import { dataDir, type LocalWorkspace } from './state'

/** 远程文件与 Git 工具共用的敏感名称规则，避免不同读取入口出现过滤差异。 */
export const SENSITIVE_NAMES = [
  '.git',
  '.remote-code-mcp',
  '.netrc',
  '_netrc',
  '.pypirc',
  '.ssh',
  '.npmrc',
  '.env',
  '.git-credentials',
  '.gitconfig',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
  'node_modules',
  '.pnpm',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.config',
  '.docker',
  '.gnupg',
  '.password-store',
  'secrets',
  'secret',
  'certs',
  'authorized_keys',
  'known_hosts',
  '.ds_store',
  'thumbs.db',
] as const

/** 禁止远程读取的证书、密钥和密钥库扩展名。 */
export const SENSITIVE_EXTENSIONS = [
  'pem',
  'key',
  'p12',
  'pfx',
  'jks',
  'keystore',
  'kdb',
  'p8',
  'crt',
  'cer',
] as const

const forbidden = new Set<string>(SENSITIVE_NAMES)
const sensitiveExtensionPattern = new RegExp('\\.(' + SENSITIVE_EXTENSIONS.join('|') + ')$', 'i')

/** 公开 .env 示例模板允许访问，真实环境配置及其他敏感名称仍然禁止。 */
export const isSensitive = (name: string) => {
  const n = name.toLowerCase()
  return (
    forbidden.has(n) ||
    // 同目录临时文件可能仍在接收上传，所有远程文件及 Git 入口均须屏蔽。
    /^\.rcm-[0-9a-f-]{36}\.tmp$/.test(n) ||
    (n.startsWith('.env.') && !n.endsWith('.example')) ||
    sensitiveExtensionPattern.test(n)
  )
}

/** 路径语法级 Hard Deny：在审批前调用，禁止路径穿越、ADS、设备名和控制字符。 */
export function assertSafeRelativePath(requested: string, allowRoot = false) {
  if (
    typeof requested !== 'string' ||
    !requested ||
    requested.includes('\0') ||
    requested.includes('\\') ||
    path.isAbsolute(requested) ||
    path.win32.isAbsolute(requested) ||
    requested.includes(':') ||
    /[<>"|?*]/.test(requested) ||
    [...requested].some((character) => character.charCodeAt(0) < 32)
  )
    throw Error('HARD_DENY_INVALID_PATH')

  if (requested === '.' && allowRoot) return
  const segments = requested.split('/')
  if (segments.some(isSensitive)) throw Error('SENSITIVE_PATH_DENIED')
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /[. ]$/.test(segment) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(segment),
    )
  )
    throw Error('HARD_DENY_PATH_SEGMENT')
}

const inside = (root: string, item: string) => item === root || item.startsWith(root + path.sep)

/** 同时保护数据目录的配置路径与真实路径，覆盖自定义目录和目录别名。 */
export async function assertNotRuntimeData(target: string) {
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const configured = normalize(dataDir)
  let actual = configured
  try {
    actual = normalize(await fs.realpath(dataDir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const item = normalize(target)
  if (inside(configured, item) || inside(actual, item)) throw Error('HARD_DENY_RUNTIME_DATA')
}

/**
 * 校验工作区内的相对路径及当前可见的符号链接。
 * 重要：该校验并非 OS 级沙箱；无法单独消除父目录被并发替换的竞态风险。
 * Runtime 仍应以最小操作系统权限运行。
 */
export async function resolveSafe(
  w: Pick<LocalWorkspace, 'root'>,
  requested: string,
  mayCreate = false,
) {
  assertSafeRelativePath(requested, true)
  const root = await fs.realpath(w.root)
  const normalizeRoot = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value
  // 授权时已保存规范化路径；祖先目录被替换为链接时不能重新解释授权边界。
  if (normalizeRoot(root) !== normalizeRoot(path.resolve(w.root)))
    throw Error('HARD_DENY_WORKSPACE_ROOT_CHANGED')
  const rootStat = await fs.lstat(w.root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw Error('HARD_DENY_SYMLINK')
  await assertNotRuntimeData(root)
  if (root.split(path.sep).some(isSensitive)) throw Error('SENSITIVE_PATH_DENIED')
  const target = path.resolve(root, requested)
  await assertNotRuntimeData(target)
  if (!inside(root, target)) throw Error('HARD_DENY_OUTSIDE_WORKSPACE')

  // 检查每一级现存路径组件，拒绝符号链接与非目录父级。
  let current = root
  const parts = path.relative(root, target).split(path.sep).filter(Boolean)
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw Error('HARD_DENY_SYMLINK')
      if (stat.isFile() && stat.nlink > 1) throw Error('HARD_DENY_HARDLINK')
      if (index < parts.length - 1 && !stat.isDirectory()) throw Error('NOT_DIRECTORY')
      if (index === parts.length - 1 && mayCreate && !stat.isFile()) throw Error('NOT_REGULAR_FILE')
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        mayCreate &&
        index === parts.length - 1
      )
        break
      throw error
    }
  }
  const checked = await fs.realpath(mayCreate ? path.dirname(target) : target)
  if (!inside(root, checked)) throw Error('HARD_DENY_SYMLINK_ESCAPE')
  await assertNotRuntimeData(checked)
  if (path.relative(root, checked).split(path.sep).some(isSensitive))
    throw Error('SENSITIVE_PATH_DENIED')
  return target
}
