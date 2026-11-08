import fs from 'node:fs/promises'
import path from 'node:path'
import { constants } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import type { LocalWorkspace } from './state'
import { resolveSafe } from './path-safety'

/** 单次文件读写允许的最大字节数，避免大文件导致内存耗尽。 */
const MAX_FILE = 512 * 1024

/** 计算文件内容的 SHA-256，用于乐观并发控制。 */
export const sha = (content: string) => createHash('sha256').update(content).digest('hex')

/**
 * 校验路径并以文件描述符读取内容，限制文件大小及普通文件类型。
 * 校验后仍需 OS 级授权限制，不能视为无竞态沙箱。
 */
export async function readChecked(w: LocalWorkspace, relative: string, maxSize = MAX_FILE) {
  const filename = await resolveSafe(w, relative)
  const fd = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const st = await fd.stat()
    if (!st.isFile() || st.size > maxSize) throw Error('FILE_TOO_LARGE_OR_UNSUPPORTED')
    // Verify name still resolves to the same inode after opening.
    const latest = await resolveSafe(w, relative)
    const named = await fs.stat(latest)
    if (named.dev !== st.dev || named.ino !== st.ino) throw Error('FILE_CHANGED')
    const data = await fd.readFile({ encoding: 'utf8' })
    if (Buffer.byteLength(data, 'utf8') > maxSize || data.includes('\0'))
      throw Error('FILE_TOO_LARGE_OR_UNSUPPORTED')
    return data
  } finally {
    await fd.close()
  }
}

/**
 * 通过预期内容 Hash 防止覆盖旧版本，再写入临时文件并原子替换。
 * 不允许无 Hash 覆盖现有文件。
 */
export async function writeChecked(
  w: LocalWorkspace,
  relative: string,
  content: string,
  expected?: string,
) {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE) throw Error('FILE_TOO_LARGE')
  const target = await resolveSafe(w, relative, true)
  let previous: string | undefined
  try {
    previous = await readChecked(w, relative)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (previous === undefined && expected) throw Error('FILE_CONFLICT: file absent')
  if (previous !== undefined && (!expected || sha(previous) !== expected))
    throw Error('FILE_CONFLICT: expectedSha256 required for replacement')

  const temporary = path.join(path.dirname(target), '.rcm-' + randomUUID() + '.tmp')
  const fd = await fs.open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
    0o600,
  )
  try {
    await fd.writeFile(content, 'utf8')
    await fd.sync()
  } finally {
    await fd.close()
  }
  try {
    // Recheck directory & optimistic version immediately before rename.
    await resolveSafe(w, relative, true)
    if (previous !== undefined) {
      const current = await readChecked(w, relative)
      if (sha(current) !== expected) throw Error('FILE_CONFLICT')
    } else {
      try {
        await fs.lstat(target)
        throw Error('FILE_CONFLICT: file appeared')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
    }
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
  return { path: relative, sha256: sha(content), written: true }
}
