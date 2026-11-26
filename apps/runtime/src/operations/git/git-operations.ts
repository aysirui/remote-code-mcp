import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LocalWorkspace } from '../../workspace/state'
import { measureFile } from '../../workspace/io'
import { assertSafeRelativePath, resolveSafe, isSensitive } from '../../workspace/path-safety'

const exec = promisify(execFile)
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'

/**
 * 固定 Git 配置：禁用外部 diff、fsmonitor、hooks 和签名。
 * 所有 Git 工具只调用内置子命令，不接受任意参数或 Shell。
 */
const gitArgs = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.external=',
  '-c',
  'diff.trustExitCode=false',
  '-c',
  'core.hooksPath=' + nullDevice,
  '-c',
  'commit.gpgSign=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'diff.submodule=short',
]
const gitEnv = () => ({
  PATH: process.env.PATH,
  Path: process.env.Path,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: nullDevice,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ATTR_NOSYSTEM: '1',
})

const inside = (root: string, item: string) => item === root || item.startsWith(root + path.sep)

/** Git 仓库必须恰好位于授权工作区根目录，且 .git 元数据不得指向工作区外。 */
async function assertWorkspaceGitRoot(workspace: LocalWorkspace) {
  const root = await resolveSafe(workspace, '.')
  const [top, gitDir] = await Promise.all([
    exec('git', [...gitArgs, 'rev-parse', '--show-toplevel'], {
      cwd: root,
      env: gitEnv(),
      timeout: 5000,
      maxBuffer: 16 * 1024,
    }),
    exec('git', [...gitArgs, 'rev-parse', '--absolute-git-dir'], {
      cwd: root,
      env: gitEnv(),
      timeout: 5000,
      maxBuffer: 16 * 1024,
    }),
  ])
  const repositoryRoot = await fs.realpath(top.stdout.trim())
  const metadataRoot = await fs.realpath(gitDir.stdout.trim())
  const normalize = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)
  if (normalize(repositoryRoot) !== normalize(root) || !inside(root, metadataRoot))
    throw Error('GIT_REPOSITORY_OUTSIDE_WORKSPACE')
  await assertNoGitFilters(root)
  return root
}

/** 所有 Git 入口拒绝有效配置中的外部 filter，包含 include 引入的配置。 */
async function assertNoGitFilters(root: string) {
  try {
    const { stdout } = await exec(
      'git',
      [...gitArgs, 'config', '--includes', '--get-regexp', '^filter\\.'],
      {
        cwd: root,
        env: gitEnv(),
        timeout: 5000,
        maxBuffer: 32 * 1024,
      },
    )
    if (stdout.trim()) throw Error('GIT_FILTERS_NOT_ALLOWED')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'GIT_FILTERS_NOT_ALLOWED') throw error
    const code = (error as { code?: number | string }).code
    if (code !== 1) throw error
  }
}

/** 返回当前分支和非敏感文件状态；过滤密钥目录及凭据文件名。 */
export async function gitStatus(workspace: LocalWorkspace) {
  const root = await assertWorkspaceGitRoot(workspace)
  const { stdout } = await exec(
    'git',
    [...gitArgs, 'status', '--short', '--branch', '--ignore-submodules=all'],
    {
      cwd: root,
      env: gitEnv(),
      timeout: 10000,
      maxBuffer: 256 * 1024,
    },
  )
  return stdout
    .split('\n')
    .filter((line) => !line.split(/[\s/\\]+/).some(isSensitive))
    .join('\n')
}

/** 返回最近提交的精简元数据；不返回文件列表、补丁或仓库绝对路径。 */
export async function gitLog(workspace: LocalWorkspace, limit = 10) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw Error('INVALID_GIT_LOG_LIMIT')
  const root = await assertWorkspaceGitRoot(workspace)
  const { stdout } = await exec(
    'git',
    [
      ...gitArgs,
      '--no-pager',
      'log',
      '-n',
      String(limit),
      '--date=short',
      '--format=%h%x09%ad%x09%an%x09%s',
    ],
    { cwd: root, env: gitEnv(), timeout: 10000, maxBuffer: 128 * 1024 },
  )
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, date, author, ...subject] = line.split('\t')
      return { hash, date, author, subject: subject.join('\t').slice(0, 300) }
    })
}

/** 只返回工作区内受允许文件的未暂存 Diff，禁止外部 Diff 和 Textconv。 */
export async function gitDiff(workspace: LocalWorkspace) {
  const root = await assertWorkspaceGitRoot(workspace)
  // Git 直接读取工作树，不经过文件工具；先验证候选文件，防止硬链接和私有目录旁路。
  const { stdout: tracked } = await exec('git', [...gitArgs, 'ls-files', '-z', '--', '.'], {
    cwd: root,
    env: gitEnv(),
    timeout: 5000,
    maxBuffer: 512 * 1024,
  })
  const files = [...new Set(tracked.split('\0').filter(Boolean))].filter(
    (file) => !file.split('/').some(isSensitive),
  )
  if (files.length > 2000) throw Error('GIT_TOO_MANY_FILES')
  for (const file of files) {
    try {
      await resolveSafe(workspace, file)
    } catch (error) {
      // 已删除的文件仍允许展示删除 Diff；其父目录必须经过相同校验。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      assertSafeRelativePath(file)
      await resolveSafe(workspace, path.posix.dirname(file))
    }
  }
  // 仅传递已校验的字面路径；禁用重命名检测，避免读取被过滤的旧路径。
  // 分批限制 Windows 命令行长度，合并结果仍遵守原有输出上限。
  let output = ''
  let batch: string[] = []
  let length = 0
  async function appendDiff() {
    if (!batch.length) return
    const { stdout } = await exec(
      'git',
      [
        ...gitArgs,
        '--literal-pathspecs',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--ignore-submodules=all',
        '--',
        ...batch,
      ],
      { cwd: root, env: gitEnv(), timeout: 10000, maxBuffer: 512 * 1024 },
    )
    output += stdout
    if (Buffer.byteLength(output) > 512 * 1024) throw Error('FILE_TOO_LARGE')
    batch = []
    length = 0
  }
  for (const file of files) {
    if (length + file.length * 2 + 4 > 12000) await appendDiff()
    batch.push(file)
    length += file.length * 2 + 4
  }
  await appendDiff()
  return output
}

/** 读取暂存区文件清单并执行数量、路径和敏感文件 Hard Deny。 */
async function stagedPaths(root: string): Promise<string[]> {
  const { stdout } = await exec('git', [...gitArgs, 'diff', '--cached', '--name-only', '-z'], {
    cwd: root,
    env: gitEnv(),
    timeout: 5000,
    maxBuffer: 128 * 1024,
  })
  const files = stdout.split('\0').filter(Boolean)
  if (!files.length) throw Error('GIT_NOTHING_STAGED')
  if (files.length > 100 || files.some((file) => file.length > 500))
    throw Error('GIT_TOO_MANY_STAGED_FILES')
  for (const file of files) {
    assertSafeRelativePath(file)
    if (file.split('/').some(isSensitive)) throw Error('HARD_DENY_SENSITIVE_GIT_PATH')
  }
  return files
}

/** 暂存前读取普通文件内容并计算 SHA-256，作为审批期间的资源指纹。 */
async function addSnapshot(workspace: LocalWorkspace, files: string[]) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 50)
    throw Error('INVALID_GIT_ADD_PATHS')
  const root = await assertWorkspaceGitRoot(workspace)
  await assertNoGitFilters(root)
  const seen = new Set<string>()
  let totalBytes = 0
  const entries: Array<{ path: string; size: number; sha256: string }> = []
  for (const file of files) {
    assertSafeRelativePath(file)
    if (seen.has(file)) throw Error('DUPLICATE_GIT_ADD_PATH')
    seen.add(file)
    const absolute = await resolveSafe(workspace, file)
    const stat = await fs.lstat(absolute)
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('GIT_ADD_REGULAR_FILES_ONLY')
    if (stat.size > 5 * 1024 * 1024) throw Error('GIT_ADD_FILE_TOO_LARGE')
    totalBytes += stat.size
    if (totalBytes > 20 * 1024 * 1024) throw Error('GIT_ADD_TOTAL_TOO_LARGE')
    const content = await measureFile(workspace, file, 5 * 1024 * 1024)
    entries.push({
      path: file,
      ...content,
    })
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
  return { root, entries, fingerprint }
}

/** 对当前暂存区计算 Tree 与文件清单指纹，防止审批等待期间替换提交内容。 */
async function commitSnapshot(workspace: LocalWorkspace) {
  const root = await assertWorkspaceGitRoot(workspace)
  await assertNoGitFilters(root)
  const files = await stagedPaths(root)
  const { stdout: tree } = await exec('git', [...gitArgs, 'write-tree'], {
    cwd: root,
    env: gitEnv(),
    timeout: 5000,
    maxBuffer: 16 * 1024,
  })
  const fingerprint = createHash('sha256')
    .update(tree.trim() + '\0' + files.join('\0'))
    .digest('hex')
  return { root, files, tree: tree.trim(), fingerprint }
}

/** 审批时显示精确文件列表，并绑定文件内容快照，避免等待审批期间换内容。 */
export async function gitApprovalContext(
  workspace: LocalWorkspace,
  operation: string,
  payload: unknown,
) {
  if (operation === 'git.add') {
    const data = payload as { paths: string[] }
    const snapshot = await addSnapshot(workspace, data.paths)
    return {
      path: snapshot.entries.map((entry) => entry.path).join(', '),
      preview:
        '暂存以下普通文件（单文件最大 5 MiB，总计最大 20 MiB）：\n' +
        snapshot.entries.map((entry) => entry.path + ' (' + entry.size + ' bytes)').join('\n'),
      fingerprint: snapshot.fingerprint,
    }
  }
  if (operation === 'git.commit') {
    const snapshot = await commitSnapshot(workspace)
    const message = (payload as { message: string }).message
    return {
      path: snapshot.files.join(', '),
      preview: '提交当前已暂存文件：\n' + snapshot.files.join('\n') + '\n\n提交说明：\n' + message,
      fingerprint: snapshot.fingerprint,
    }
  }
  throw Error('UNSUPPORTED_GIT_APPROVAL')
}

/** 将指定的普通文件加入暂存区；不接受目录、路径通配符或 Git pathspec magic。 */
export async function gitAdd(
  workspace: LocalWorkspace,
  files: string[],
  expectedFingerprint?: string,
) {
  const snapshot = await addSnapshot(workspace, files)
  if (expectedFingerprint && snapshot.fingerprint !== expectedFingerprint)
    throw Error('GIT_STATE_CHANGED_DURING_APPROVAL')
  const { stdout, stderr } = await exec(
    'git',
    [...gitArgs, 'add', '--', ...snapshot.entries.map((entry) => entry.path)],
    {
      cwd: snapshot.root,
      env: gitEnv(),
      timeout: 15000,
      maxBuffer: 64 * 1024,
    },
  )
  return {
    staged: snapshot.entries.map((entry) => entry.path),
    output: (stdout + stderr).slice(0, 2000),
  }
}

/** 仅提交当前暂存区；禁用 hooks 和签名，不支持 amend、空提交或任意 Git 参数。 */
export async function gitCommit(
  workspace: LocalWorkspace,
  message: string,
  expectedFingerprint?: string,
) {
  if (typeof message !== 'string' || !message.trim() || message.length > 500)
    throw Error('INVALID_GIT_COMMIT_MESSAGE')
  const snapshot = await commitSnapshot(workspace)
  if (expectedFingerprint && snapshot.fingerprint !== expectedFingerprint)
    throw Error('GIT_STATE_CHANGED_DURING_APPROVAL')
  const result = await exec(
    'git',
    [...gitArgs, 'commit', '--no-verify', '--no-gpg-sign', '-m', message.trim()],
    { cwd: snapshot.root, env: gitEnv(), timeout: 20000, maxBuffer: 128 * 1024 },
  )
  const output = typeof result === 'string' ? result : result.stdout
  return { committed: snapshot.files, tree: snapshot.tree, output: output.slice(0, 4000) }
}
