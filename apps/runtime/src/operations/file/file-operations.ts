import fs from 'node:fs/promises'
import path from 'node:path'
import { constants } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import type { LocalWorkspace } from '../../workspace/state'
import { logger, summarizeError } from '../../logger'
import {
  resolveSafe,
  isSensitive,
  assertSafeRelativePath,
  assertNotRuntimeData,
} from './path-safety'

/** 单次文件读写允许的最大字节数，避免大文件导致内存耗尽。 */
const MAX_FILE = 512 * 1024

/** 计算文件内容的 SHA-256，用于乐观并发控制。 */
export const sha = (content: string) => createHash('sha256').update(content).digest('hex')

/**
 * 校验路径并以文件描述符读取内容，限制文件大小及普通文件类型。
 * 校验后仍需 OS 级授权限制，不能视为无竞态沙箱。
 */
export async function readBufferChecked(w: LocalWorkspace, relative: string, maxSize = MAX_FILE) {
  const filename = await resolveSafe(w, relative)
  const fd = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const st = await fd.stat()
    if (st.nlink > 1) throw Error('HARD_DENY_HARDLINK')
    if (!st.isFile() || st.size > maxSize) throw Error('FILE_TOO_LARGE_OR_UNSUPPORTED')
    // Verify name still resolves to the same inode after opening.
    const latest = await resolveSafe(w, relative)
    const named = await fs.stat(latest)
    if (named.dev !== st.dev || named.ino !== st.ino) throw Error('FILE_CHANGED')
    // 有界读取防止校验后文件增长导致内存耗尽；读取后重新校验链接和路径。
    const buffer = Buffer.alloc(maxSize + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await fd.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxSize) throw Error('FILE_TOO_LARGE_OR_UNSUPPORTED')
    const after = await fd.stat()
    const finalPath = await resolveSafe(w, relative)
    const finalStat = await fs.lstat(finalPath)
    if (after.nlink > 1 || finalStat.nlink > 1) throw Error('HARD_DENY_HARDLINK')
    if (
      after.size !== st.size ||
      after.mtimeMs !== st.mtimeMs ||
      after.ctimeMs !== st.ctimeMs ||
      finalStat.dev !== st.dev ||
      finalStat.ino !== st.ino
    )
      throw Error('FILE_CHANGED')
    return buffer.subarray(0, length)
  } finally {
    await fd.close()
  }
}

/** 文本工具额外拒绝二进制数据；Git 暂存复用相同边界检查并保留原始字节。 */
export async function readChecked(w: LocalWorkspace, relative: string, maxSize = MAX_FILE) {
  const data = (await readBufferChecked(w, relative, maxSize)).toString('utf8')
  if (Buffer.byteLength(data, 'utf8') > maxSize || data.includes('\0'))
    throw Error('FILE_TOO_LARGE_OR_UNSUPPORTED')
  return data
}

/**
 * 在已授权工作区内按区分大小写的文本包含规则搜索，返回相对路径、行号和匹配文本。
 * @param w 已通过请求访问权限校验的本机工作区；路径与文件读取仍执行安全检查。
 * @param relative 搜索起点相对于工作区根目录的路径，可为文件或目录。
 * @param query 要匹配的原始文本，不解释为正则表达式。
 * @returns 最多 100 条匹配，每条文本最多 250 个字符；最多访问 2000 个路径，单文件限 256 KiB。
 */
export async function searchChecked(w: LocalWorkspace, relative: string, query: string) {
  await resolveSafe(w, relative)
  const matches: Array<{
    /** 匹配文件相对于工作区根目录的路径。 */
    path: string
    /** 从 1 开始的匹配行号。 */
    line: number
    /** 匹配行的前 250 个字符。 */
    text: string
  }> = []
  const visited = new Set<string>()
  let count = 0
  /** 遍历工作区相对路径，跳过不允许读取的文件并遵守搜索数量限制。 */
  async function visit(relative: string) {
    if (++count > 2000 || matches.length >= 100) return
    let current: string
    try {
      current = await resolveSafe(w, relative)
    } catch {
      return
    }
    if (visited.has(current)) return
    visited.add(current)
    const stat = await fs.lstat(current)
    if (stat.isFile()) {
      let source: string
      try {
        source = await readChecked(w, relative, 256 * 1024)
      } catch {
        return
      }
      for (const [i, line] of source.split('\n').entries()) {
        if (line.includes(query))
          matches.push({ path: relative, line: i + 1, text: line.slice(0, 250) })
        if (matches.length >= 100) break
      }
    } else if (stat.isDirectory()) {
      for (const child of await fs.readdir(current, { withFileTypes: true })) {
        if (isSensitive(child.name) || child.isSymbolicLink()) continue
        await visit(path.posix.join(relative, child.name))
        if (matches.length >= 100 || count > 2000) break
      }
    }
  }
  await visit(relative)
  return matches
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
  if (previous === undefined && expected) throw Error('FILE_CONFLICT')
  if (previous !== undefined && (!expected || sha(previous) !== expected))
    throw Error('FILE_CONFLICT')

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
        throw Error('FILE_CONFLICT')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
    }
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch((error: unknown) => {
      logger.error('file.temporary.cleanup_failed', {
        code: 'FILE_TEMP_CLEANUP_FAILED',
        error: summarizeError(error),
      })
    })
  }
  return { path: relative, sha256: sha(content), written: true }
}

/**
 * 验证新建/移动目标。与 resolveSafe 的区别是允许末端尚不存在或为目录，
 * 但父目录必须存在且所有已存在路径段不得是符号链接。
 */
async function safeDestination(w: LocalWorkspace, requested: string) {
  assertSafeRelativePath(requested)
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
  await assertNotRuntimeData(target)
  if (target === root || !target.startsWith(root + path.sep)) throw Error('OUTSIDE_WORKSPACE')
  return target
}

/** 删除审批阈值：递归删除超过 20 个目录项时，即使策略为 allow 也必须人工确认。 */
export const HIGH_RISK_DELETE_THRESHOLD = 20

/** 递归检查待删除树并生成稳定快照；快照用于审批前后校验资源未发生变化。 */
export async function inspectDeleteTarget(target: string) {
  const entries: Array<{
    path: string
    type: string
    dev: number
    ino: number
    size: number
    mtimeMs: number
    ctimeMs: number
    contentHash?: string
  }> = []
  let totalBytes = 0
  async function visit(current: string, relative: string) {
    await assertNotRuntimeData(current)
    if (entries.length >= 1000) throw Error('TOO_MANY_ENTRIES')
    const st = await fs.lstat(current)
    if (st.isSymbolicLink()) throw Error('SYMLINK_DENIED')
    if (st.isFile() && st.nlink > 1) throw Error('HARD_DENY_HARDLINK')
    if (st.isDirectory()) {
      entries.push({
        path: relative,
        type: 'directory',
        dev: st.dev,
        ino: st.ino,
        size: st.size,
        mtimeMs: st.mtimeMs,
        ctimeMs: st.ctimeMs,
      })
      const children = (await fs.readdir(current)).sort()
      for (const child of children) {
        if (isSensitive(child)) throw Error('SENSITIVE_PATH_DENIED')
        await visit(path.join(current, child), relative ? relative + '/' + child : child)
      }
      // 遍历期间目录被替换或增删条目时，不生成混合时刻的审批快照。
      const after = await fs.lstat(current)
      if (
        after.isSymbolicLink() ||
        after.dev !== st.dev ||
        after.ino !== st.ino ||
        after.mtimeMs !== st.mtimeMs ||
        after.ctimeMs !== st.ctimeMs ||
        JSON.stringify((await fs.readdir(current)).sort()) !== JSON.stringify(children)
      )
        throw Error('DELETE_TARGET_CHANGED_DURING_APPROVAL')
      return
    }
    if (!st.isFile()) throw Error('UNSUPPORTED_FILE_TYPE')
    // 内容参与快照，防止同长度改写并恢复 mtime 后复用旧审批；限制总读取量。
    totalBytes += st.size
    if (totalBytes > 64 * 1024 * 1024) throw Error('DELETE_SNAPSHOT_TOO_LARGE')
    const fd = await fs.open(current, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    let contentHash: string
    try {
      const opened = await fd.stat()
      if (!opened.isFile() || opened.nlink > 1 || opened.dev !== st.dev || opened.ino !== st.ino)
        throw Error('DELETE_TARGET_CHANGED_DURING_APPROVAL')
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(64 * 1024)
      let readBytes = 0
      for (;;) {
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        readBytes += bytesRead
        if (readBytes > st.size) throw Error('DELETE_TARGET_CHANGED_DURING_APPROVAL')
        hash.update(buffer.subarray(0, bytesRead))
      }
      const after = await fd.stat()
      const named = await fs.lstat(current)
      if (
        readBytes !== st.size ||
        after.mtimeMs !== st.mtimeMs ||
        after.ctimeMs !== st.ctimeMs ||
        named.dev !== st.dev ||
        named.ino !== st.ino ||
        named.isSymbolicLink() ||
        named.nlink > 1 ||
        after.nlink > 1
      )
        throw Error('DELETE_TARGET_CHANGED_DURING_APPROVAL')
      contentHash = hash.digest('hex')
    } finally {
      await fd.close()
    }
    entries.push({
      path: relative,
      type: 'file',
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      contentHash,
    })
  }
  await visit(target, '')
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ target: path.resolve(target), entries }))
    .digest('hex')
  // 文件本身计为 1 项；目录只统计其内部子项，避免把容器目录重复计入批量删除数量。
  const entryCount = entries.length - (entries[0]?.type === 'directory' ? 1 : 0)
  // 不从目标父目录推测工作区；根目录由调用方按授权工作区明确拒绝。
  return { entryCount, fingerprint, contentHash: entries[0]?.contentHash }
}

/** 拒绝破坏性操作处理链接、敏感路径、以及超大目录树。 */
async function verifyTree(target: string, budget = { count: 0 }) {
  await assertNotRuntimeData(target)
  if (++budget.count > 1000) throw Error('TOO_MANY_ENTRIES')
  const st = await fs.lstat(target)
  if (st.isSymbolicLink()) throw Error('SYMLINK_DENIED')
  if (st.isFile() && st.nlink > 1) throw Error('HARD_DENY_HARDLINK')
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
  assertSafeRelativePath(requested)
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
 * 递归删除有 1000 项上限；超过 20 个目录项时由 Runtime 风险层强制逐次审批。
 */
export async function deleteChecked(
  w: LocalWorkspace,
  requested: string,
  recursive: boolean,
  expectedSha256?: string,
  expectedResourceHash?: string,
) {
  assertMutationSource(requested)
  const target = await resolveSafe(w, requested)
  if (target === (await fs.realpath(w.root))) throw Error('WORKSPACE_ROOT_PROTECTED')
  const snapshot = await inspectDeleteTarget(target)
  if (recursive && snapshot.entryCount > HIGH_RISK_DELETE_THRESHOLD && !expectedResourceHash)
    throw Error('HIGH_RISK_DELETE_REQUIRES_APPROVAL')
  if (expectedResourceHash && snapshot.fingerprint !== expectedResourceHash)
    throw Error('DELETE_TARGET_CHANGED_DURING_APPROVAL')
  const st = await fs.lstat(target)
  if (st.isSymbolicLink()) throw Error('SYMLINK_DENIED')
  if (st.isFile()) {
    if (!expectedSha256) throw Error('EXPECTED_SHA256_REQUIRED')
    // 删除比较原始字节的 SHA-256；复用快照的流式校验，支持 PNG 等二进制文件。
    if (snapshot.contentHash !== expectedSha256) throw Error('FILE_CONFLICT')
    const latest = await inspectDeleteTarget(target)
    if (latest.fingerprint !== snapshot.fingerprint)
      throw Error('DELETE_TARGET_CHANGED_DURING_APPROVAL')
    await fs.unlink(target)
  } else if (st.isDirectory()) {
    if (expectedSha256) throw Error('INVALID_FILE_HASH')
    if (recursive) {
      await verifyTree(target)
      await resolveSafe(w, requested)
      const latest = await inspectDeleteTarget(target)
      if (latest.fingerprint !== snapshot.fingerprint)
        throw Error('DELETE_TARGET_CHANGED_DURING_APPROVAL')
      await fs.rm(target, { recursive: true, force: false })
    } else await fs.rmdir(target)
  } else throw Error('UNSUPPORTED_FILE_TYPE')
  return { path: requested, deleted: true }
}
