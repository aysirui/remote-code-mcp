import fs from 'node:fs/promises'
import path from 'node:path'
import { constants } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ToolInputs, operationRequiresWrite, type RpcRequest } from '@rcm/protocol'
import type { LocalWorkspace } from './state'

const exec = promisify(execFile)
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const MAX_FILE = 512 * 1024
const forbidden = new Set([
  '.git', '.ssh', '.npmrc', '.env', '.git-credentials',
  'id_rsa', 'id_ed25519', 'credentials.json', 'node_modules',
  '.pnpm', '.aws', '.kube', '.config',
])
const isSensitive = (name: string) => {
  const n = name.toLowerCase()
  return forbidden.has(n) || n.startsWith('.env.') ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(n) ||
    n === 'authorized_keys' || n === 'known_hosts'
}
const inside = (root: string, item: string) =>
  item === root || item.startsWith(root + path.sep)

/**
 * Defense in depth, not an OS filesystem sandbox: Node's path APIs cannot
 * atomically resolve all parent components (openat2/dirfd on Linux).
 * Runtime must run with OS-level access limited to approved directories.
 */
export async function resolveSafe(w: LocalWorkspace, requested: string, mayCreate = false) {
  if (!requested || requested.includes('\0') ||
      path.isAbsolute(requested) || path.win32.isAbsolute(requested) ||
      requested.includes('\\')) throw Error('INVALID_PATH')

  const segments = requested.split('/')
  if (segments.some(s => s === '..' || isSensitive(s))) throw Error('INVALID_PATH')

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
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && mayCreate && current === target)
        break
      throw e
    }
  }
  const checked = await fs.realpath(mayCreate ? path.dirname(target) : target)
  if (!inside(root, checked)) throw Error('SYMLINK_ESCAPE')
  return target
}

async function readChecked(w: LocalWorkspace, relative: string, maxSize = MAX_FILE) {
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

async function writeChecked(w: LocalWorkspace, relative: string, content: string, expected?: string) {
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
  const fd = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
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

const gitArgs = ['--no-optional-locks', '-c', 'core.fsmonitor=false',
  '-c', 'diff.external=', '-c', 'diff.trustExitCode=false']
const gitEnv = () => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
})
const diffExcludes = [
  ':(exclude,glob)**/.env*', ':(exclude,glob)**/.npmrc',
  ':(exclude,glob)**/*.pem', ':(exclude,glob)**/*.key',
  ':(exclude,glob)**/credentials.json', ':(exclude,glob)**/.ssh/**',
]

export async function execute(w: LocalWorkspace, req: RpcRequest) {
  if (req.workspaceId !== w.id) throw Error('WORKSPACE_ID_MISMATCH')
  if (req.deadlineAt < Date.now()) throw Error('REQUEST_EXPIRED')
  if (!w.enabled) throw Error('WORKSPACE_DISABLED')
  if (!w.permissions.read || (operationRequiresWrite(req.operation) && !w.permissions.write))
    throw Error('PERMISSION_DENIED')
  const payload = ToolInputs[req.operation].parse(req.payload) as any
  switch (req.operation) {
    case 'file.list': {
      const filename = await resolveSafe(w, payload.path)
      const stat = await fs.lstat(filename)
      if (!stat.isDirectory()) throw Error('NOT_DIRECTORY')
      return (await fs.readdir(filename, { withFileTypes: true }))
        .filter(e => !isSensitive(e.name) && !e.isSymbolicLink())
        .slice(0, 500)
        .map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
    }
    case 'file.read': {
      const content = await readChecked(w, payload.path)
      return { content, sha256: sha(content) }
    }
    case 'file.search': {
      await resolveSafe(w, payload.path)
      const matches: Array<{ path: string; line: number; text: string }> = []
      const visited = new Set<string>()
      let count = 0
      async function visit(relative: string) {
        if (++count > 2000 || matches.length >= 100) return
        let current: string
        try { current = await resolveSafe(w, relative) } catch { return }
        if (visited.has(current)) return
        visited.add(current)
        const stat = await fs.lstat(current)
        if (stat.isFile()) {
          let source: string
          try { source = await readChecked(w, relative, 256 * 1024) } catch { return }
          for (const [i, line] of source.split('\n').entries()) {
            if (line.includes(payload.query))
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
      await visit(payload.path)
      return matches
    }
    case 'file.write':
      return writeChecked(w, payload.path, payload.content, payload.expectedSha256)
    case 'git.status': {
      const { stdout } = await exec('git', [...gitArgs, 'status', '--short', '--branch'], {
        cwd: await resolveSafe(w, '.'), env: gitEnv(), timeout: 10000, maxBuffer: 256 * 1024,
      })
      return stdout.split('\n').filter(line => !line.split(/[\s/\\]+/).some(isSensitive)).join('\n')
    }
    case 'git.diff': {
      const { stdout } = await exec('git',
        [...gitArgs, 'diff', '--no-ext-diff', '--no-textconv', '--', '.', ...diffExcludes],
        { cwd: await resolveSafe(w, '.'), env: gitEnv(), timeout: 10000, maxBuffer: 512 * 1024 })
      return stdout
    }
    default: throw Error('UNSUPPORTED_OPERATION')
  }
}
