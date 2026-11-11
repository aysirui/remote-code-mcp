import fs from 'node:fs/promises'
import path from 'node:path'
import type { LocalWorkspace } from './state'

/** 禁止通过远程文件工具读取、写入、移动或删除的敏感名称。 */
const forbidden = new Set([
  '.git',
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
])
export const isSensitive = (name: string) => {
  const n = name.toLowerCase()
  return (
    forbidden.has(n) ||
    n.startsWith('.env.') ||
    /\.(?:pem|key|p12|pfx|jks|keystore|kdb|p8|crt|cer)$/i.test(n) ||
    n === 'authorized_keys' ||
    n === 'known_hosts' ||
    n === '.ds_store' ||
    n === 'thumbs.db'
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
    /[<>"|?*\x00-\x1f]/.test(requested)
  )
    throw Error('HARD_DENY_INVALID_PATH')

  if (requested === '.' && allowRoot) return
  const segments = requested.split('/')
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        isSensitive(segment) ||
        /[. ]$/.test(segment) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(segment),
    )
  )
    throw Error('HARD_DENY_PATH_SEGMENT')
}

const inside = (root: string, item: string) => item === root || item.startsWith(root + path.sep)

/**
 * 校验工作区内的相对路径及当前可见的符号链接。
 * 重要：该校验并非 OS 级沙箱；无法单独消除父目录被并发替换的竞态风险。
 * Runtime 仍应以最小操作系统权限运行。
 */
export async function resolveSafe(w: LocalWorkspace, requested: string, mayCreate = false) {
  assertSafeRelativePath(requested, true)
  const root = await fs.realpath(w.root)
  const rootName = path.basename(root).toLowerCase()
  if (isSensitive(rootName)) throw Error('HARD_DENY_SENSITIVE_WORKSPACE_ROOT')
  const target = path.resolve(root, requested)
  if (!inside(root, target)) throw Error('HARD_DENY_OUTSIDE_WORKSPACE')

  // 检查每一级现存路径组件，拒绝符号链接与非目录父级。
  let current = root
  const parts = path.relative(root, target).split(path.sep).filter(Boolean)
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw Error('HARD_DENY_SYMLINK')
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
  return target
}
