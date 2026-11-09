import fs from 'node:fs/promises'
import path from 'node:path'
import { constants } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import type { LocalWorkspace } from './state'
import { resolveSafe, isSensitive } from './path-safety'

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

/**
 * 验证新建/移动目标。与 resolveSafe 的区别是允许末端尚不存在或为目录，
 * 但父目录必须存在且所有已存在路径段不得是符号链接。
 */
async function safeDestination(w: LocalWorkspace, requested: string) {
  if (
    !requested ||
    requested === '.' ||
    requested.includes('\0') ||
    path.isAbsolute(requested) ||
    path.win32.isAbsolute(requested) ||
    requested.includes('\\')
  )
    throw Error('INVALID_PATH')
  const parts = requested.split('/')
  if (parts.some((name) => !name || name === '.' || name === '..' || isSensitive(name)))
    throw Error('INVALID_PATH')
  const root = await fs.realpath(w.root)
  const parent = parts.slice(0, -1).join('/') || '.'
  const parentPath = await resolveSafe(w, parent)
  if (!(await fs.lstat(parentPath)).isDirectory()) throw Error('NOT_DIRECTORY')
  const target = path.join(parentPath, parts[parts.length - 1])
  if (target === root || !target.startsWith(root + path.sep)) throw Error('OUTSIDE_WORKSPACE')
  return target
}

/** 拒绝破坏性操作处理链接、敏感路径、以及超大目录树。 */
async function verifyTree(target: string, budget = { count: 0 }) {
  if (++budget.count > 1000) throw Error('TOO_MANY_ENTRIES')
  const st = await fs.lstat(target)
  if (st.isSymbolicLink()) throw Error('SYMLINK_DENIED')
  if (!st.isDirectory()) {
    if (!st.isFile()) throw Error('UNSUPPORTED_FILE_TYPE')
    return
  }
  for (const child of await fs.readdir(target)) {
    if (isSensitive(child)) throw Error('SENSITIVE_PATH_DENIED')
    await verifyTree(path.join(target, child), budget)
  }
}

/** 创建目录；每级路径均校验，禁止从工作区跳转至绝对路径、链接或敏感目录。 */
export async function mkdirChecked(w: LocalWorkspace, requested: string, recursive: boolean) {
  if (!recursive) {
    const target = await safeDestination(w, requested)
    await fs.mkdir(target)
    return { path: requested, created: true }
  }
  const parts = requested.split('/')
  if (
    !parts.length ||
    parts.some((x) => !x || x === '.' || x === '..' || isSensitive(x)) ||
    path.isAbsolute(requested) ||
    path.win32.isAbsolute(requested) ||
    requested.includes('\\')
  )
    throw Error('INVALID_PATH')
  let relative = ''
  let created = false
  for (const part of parts) {
    relative = relative ? relative + '/' + part : part
    const target = await safeDestination(w, relative)
    try {
      const st = await fs.lstat(target)
      if (st.isSymbolicLink() || !st.isDirectory()) throw Error('NOT_DIRECTORY')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      await fs.mkdir(target)
      created = true
    }
  }
  return { path: requested, created }
}

/** 拒绝通过 ./ 或尾随分隔符把整个工作区根目录当成删除/移动目标。 */
function assertMutationSource(requested: string) {
  if (!requested || requested.split('/').some((part) => !part || part === '.' || part === '..'))
    throw Error('INVALID_PATH')
}

/** 同工作区移动文件或目录，不覆盖目标、不支持跨设备拷贝或目录合并。 */
export async function moveChecked(w: LocalWorkspace, from: string, to: string) {
  assertMutationSource(from)
  if (to === '.' || from === to) throw Error('INVALID_MOVE')
  const source = await resolveSafe(w, from)
  if (source === (await fs.realpath(w.root))) throw Error('WORKSPACE_ROOT_PROTECTED')
  const target = await safeDestination(w, to)
  if (target === source || target.startsWith(source + path.sep)) throw Error('INVALID_MOVE')
  await verifyTree(source)
  try {
    await fs.lstat(target)
    throw Error('DESTINATION_EXISTS')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  await fs.rename(source, target)
  return { from, to, moved: true }
}

/**
 * 删除文件必须提供内容 SHA-256；删除目录默认仅允许空目录。
 * 递归删除有 1000 项上限且必须经本地逐次审批。
 */
export async function deleteChecked(
  w: LocalWorkspace,
  requested: string,
  recursive: boolean,
  expectedSha256?: string,
) {
  assertMutationSource(requested)
  const target = await resolveSafe(w, requested)
  if (target === (await fs.realpath(w.root))) throw Error('WORKSPACE_ROOT_PROTECTED')
  const st = await fs.lstat(target)
  if (st.isSymbolicLink()) throw Error('SYMLINK_DENIED')
  if (st.isFile()) {
    if (!expectedSha256) throw Error('EXPECTED_SHA256_REQUIRED')
    const actual = sha(await readChecked(w, requested))
    if (actual !== expectedSha256) throw Error('FILE_CONFLICT')
    await fs.unlink(target)
  } else if (st.isDirectory()) {
    if (expectedSha256) throw Error('INVALID_FILE_HASH')
    if (recursive) {
      await verifyTree(target)
      await fs.rm(target, { recursive: true, force: false })
    } else await fs.rmdir(target)
  } else throw Error('UNSUPPORTED_FILE_TYPE')
  return { path: requested, deleted: true }
}
