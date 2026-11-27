import fs from 'node:fs/promises'
import path from 'node:path'
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { filetypemime } from 'magic-bytes.js'
import type { LocalWorkspace } from './state'
import { resolveSafe } from './path-safety'
import { logger, summarizeError } from '../logger'

/** 同一目标在本机 Runtime 内按顺序写入，避免并发请求通过同一个旧版本校验。 */
const pendingWrites = new Map<string, Promise<void>>()

/** 计算已读取到内存的文件字节的 SHA-256，供文本读取结果使用。 */
export function hashFileBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 分块读取工作区内普通文件的原始字节，拒绝链接和读取期间发生变化的文件。
 * @param workspace 当前操作授权的工作区。
 * @param relative 工作区相对路径。
 * @param maxBytes 本次读取允许的最大原始字节数。
 * @returns 随消费进度读取的原始字节块。
 */
export async function* readFileChunks(
  workspace: LocalWorkspace,
  relative: string,
  maxBytes: number,
): AsyncGenerator<Buffer> {
  const filename = await resolveSafe(workspace, relative)
  const fd = await fs.open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
  )
  try {
    const before = await fd.stat()
    if (before.nlink > 1) throw Error('HARD_DENY_HARDLINK')
    if (!before.isFile()) throw Error('NOT_REGULAR_FILE')
    if (before.size > maxBytes) throw Error('FILE_TOO_LARGE')
    const named = await fs.stat(await resolveSafe(workspace, relative))
    if (named.dev !== before.dev || named.ino !== before.ino) throw Error('FILE_CHANGED')

    // 多读一个字节检测增长；每次只为当前消费的块分配内存。
    let length = 0
    while (length <= before.size) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, before.size + 1 - length))
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      length += bytesRead
      if (length > before.size) throw Error('FILE_CHANGED')
      yield buffer.subarray(0, bytesRead)
    }
    const after = await fd.stat()
    const finalStat = await fs.lstat(await resolveSafe(workspace, relative))
    if (after.nlink > 1 || finalStat.nlink > 1) throw Error('HARD_DENY_HARDLINK')
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      finalStat.dev !== before.dev ||
      finalStat.ino !== before.ino
    )
      throw Error('FILE_CHANGED')
  } finally {
    await fd.close()
  }
}

/** 读取需要一次性解码的小文件，在调用方指定的原始字节上限内收集数据。 */
export async function readFileBytes(workspace: LocalWorkspace, relative: string, maxBytes: number) {
  const chunks: Buffer[] = []
  for await (const chunk of readFileChunks(workspace, relative, maxBytes)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** 流式获取已校验文件的大小与原始字节摘要，供覆盖和 Git 审批使用。 */
export async function measureFile(workspace: LocalWorkspace, relative: string, maxBytes: number) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of readFileChunks(workspace, relative, maxBytes)) {
    hash.update(chunk)
    size += chunk.length
  }
  return { size, sha256: hash.digest('hex') }
}

/** 将文件字节无损解码为 UTF-8 文本，含 NUL 或无效 UTF-8 的文件须以二进制读取。 */
export function decodeUtf8(bytes: Buffer): string {
  if (bytes.includes(0) || !isUtf8(bytes)) throw Error('INVALID_UTF8')
  return bytes.toString('utf8')
}

/** 根据文件开头的字节识别 MIME，仅用于展示；未识别的内容仍可传输。 */
export function detectFileMimeType(bytes: Uint8Array): string {
  return filetypemime(bytes.subarray(0, 4096))[0] ?? 'application/octet-stream'
}

/**
 * 以原始字节写入同目录的临时文件，核对目标版本后替换。
 * @param workspace 当前操作授权的工作区。
 * @param relative 工作区相对路径，父目录必须存在。
 * @param source 按需读取的原始文件字节块。
 * @param options 预期长度、文件大小上限、覆盖版本及替换前的授权校验。
 * @returns 写入内容的原始字节 SHA-256。
 */
export async function writeFileStream(
  workspace: LocalWorkspace,
  relative: string,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: {
    /** 允许读取旧文件和写入新文件的最大字节数。 */
    maxBytes: number
    /** 直接上传声明的精确字节数；无长度的受控中继以完整流结束为准。 */
    size?: number
    /** 覆盖时提供当前文件摘要；省略表示仅新建。 */
    expectedSha256?: string
    /** 网络取消或审批超时后停止写入。 */
    signal?: AbortSignal
    /** 临时文件完整接收后、替换目标前再次核对授权。 */
    assertActive?: () => void
  },
): Promise<string> {
  const { maxBytes, size, expectedSha256, signal, assertActive } = options
  if (size !== undefined && size > maxBytes) throw Error('FILE_TOO_LARGE')
  const target = await resolveSafe(workspace, relative, true)
  const key =
    process.platform === 'win32' || process.platform === 'darwin'
      ? target.normalize('NFC').toLowerCase()
      : target
  const previous = pendingWrites.get(key)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  pendingWrites.set(key, pending)
  await previous
  try {
    /** 再次解析路径并核对原始字节摘要，防止排队或写临时文件期间目标改变。 */
    async function assertVersion() {
      await resolveSafe(workspace, relative, true)
      let currentSha256: string | undefined
      try {
        if (expectedSha256 === undefined) await fs.lstat(target)
        else currentSha256 = (await measureFile(workspace, relative, maxBytes)).sha256
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (expectedSha256 === undefined) return
      }
      if (expectedSha256 === undefined || currentSha256 !== expectedSha256)
        throw Error('FILE_CONFLICT')
    }

    signal?.throwIfAborted()
    await assertVersion()
    const temporary = path.join(path.dirname(target), '.rcm-' + randomUUID() + '.tmp')
    const fd = await fs.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    )
    const hash = createHash('sha256')
    let received = 0
    try {
      try {
        for await (const chunk of source) {
          signal?.throwIfAborted()
          received += chunk.byteLength
          if (received > maxBytes) throw Error('FILE_TOO_LARGE')
          if (size !== undefined && received > size) throw Error('FILE_SIZE_MISMATCH')
          hash.update(chunk)
          await fd.writeFile(chunk)
        }
        if (size !== undefined && received !== size) throw Error('FILE_SIZE_MISMATCH')
        await fd.sync()
      } finally {
        await fd.close()
      }
      // Runtime 内的并发写入已串行；外部进程仍受操作系统自身的文件权限约束。
      await assertVersion()
      signal?.throwIfAborted()
      assertActive?.()
      await fs.rename(temporary, target)
    } finally {
      await fs.rm(temporary, { force: true }).catch((error: unknown) => {
        logger.error('file.temporary.cleanup_failed', {
          code: 'FILE_TEMP_CLEANUP_FAILED',
          error: summarizeError(error),
        })
      })
    }
    return hash.digest('hex')
  } finally {
    if (pendingWrites.get(key) === pending) pendingWrites.delete(key)
    release()
  }
}
