import fs from 'node:fs/promises'
import path from 'node:path'
import type { LocalWorkspace } from './state'

/** 禁止浏览与远程读取的敏感文件及目录名称。 */
const forbidden = new Set([
  '.git',
  '.ssh',
  '.npmrc',
  '.env',
  '.git-credentials',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
  'node_modules',
  '.pnpm',
  '.aws',
  '.kube',
  '.config',
])
export const isSensitive = (name: string) => {
  const n = name.toLowerCase()
  return (
    forbidden.has(n) ||
    n.startsWith('.env.') ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(n) ||
    n === 'authorized_keys' ||
    n === 'known_hosts'
  )
}
const inside = (root: string, item: string) => item === root || item.startsWith(root + path.sep)

/**
 * 校验工作区内的相对路径及当前可见的符号链接。
 * 重要：该校验并非 OS 级沙箱；无法单独消除父目录被并发替换的竞态风险。
 * Runtime 仍应以最小操作系统权限运行。
 */
export async function resolveSafe(w: LocalWorkspace, requested: string, mayCreate = false) {
  if (
    !requested ||
    requested.includes('\0') ||
    path.isAbsolute(requested) ||
    path.win32.isAbsolute(requested) ||
    requested.includes('\\')
  )
    throw Error('INVALID_PATH')

  const segments = requested.split('/')
  if (segments.some((s) => s === '..' || isSensitive(s))) throw Error('INVALID_PATH')

  const root = await fs.realpath(w.root)
  const target = path.resolve(root, requested)
  if (!inside(root, target)) throw Error('OUTSIDE_WORKSPACE')

  // Reject symlinks in every currently visible component; do not follow them.
  let current = root
  const rel = path.relative(root, target)
  for (const [index, part] of rel.split(path.sep).filter(Boolean).entries()) {
    current = path.join(current, part)
    try {
      const s = await fs.lstat(current)
      if (s.isSymbolicLink()) throw Error('SYMLINK_DENIED')
      if (index < rel.split(path.sep).filter(Boolean).length - 1 && !s.isDirectory())
        throw Error('NOT_DIRECTORY')
      if (index === rel.split(path.sep).filter(Boolean).length - 1 && mayCreate && !s.isFile())
        throw Error('NOT_REGULAR_FILE')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && mayCreate && current === target) break
      throw e
    }
  }
  const checked = await fs.realpath(mayCreate ? path.dirname(target) : target)
  if (!inside(root, checked)) throw Error('SYMLINK_ESCAPE')
  return target
}
