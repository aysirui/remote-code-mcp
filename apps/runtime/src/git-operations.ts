import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LocalWorkspace } from './state'
import { resolveSafe, isSensitive } from './path-safety'

const exec = promisify(execFile)

/**
 * 限制 Git 查询使用的外部配置与用户环境，减少敏感文件内容泄露及命令执行风险。
 * Git 查询只是只读工具，不接受客户端提供的任意子命令。
 */
const gitArgs = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.external=',
  '-c',
  'diff.trustExitCode=false',
]
const gitEnv = () => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
})
const diffExcludes = [
  ':(exclude,glob)**/.env*',
  ':(exclude,glob)**/.npmrc',
  ':(exclude,glob)**/*.pem',
  ':(exclude,glob)**/*.key',
  ':(exclude,glob)**/credentials.json',
  ':(exclude,glob)**/.ssh/**',
]

export async function gitStatus(workspace: LocalWorkspace) {
  const { stdout } = await exec('git', [...gitArgs, 'status', '--short', '--branch'], {
    cwd: await resolveSafe(workspace, '.'),
    env: gitEnv(),
    timeout: 10000,
    maxBuffer: 256 * 1024,
  })
  return stdout
    .split('\n')
    .filter((line) => !line.split(/[\s/\\]+/).some(isSensitive))
    .join('\n')
}

/** 只返回工作区内受允许文件的未暂存 Diff，禁止外部 Diff 和 Textconv。 */
export async function gitDiff(workspace: LocalWorkspace) {
  const { stdout } = await exec(
    'git',
    [...gitArgs, 'diff', '--no-ext-diff', '--no-textconv', '--', '.', ...diffExcludes],
    {
      cwd: await resolveSafe(workspace, '.'),
      env: gitEnv(),
      timeout: 10000,
      maxBuffer: 512 * 1024,
    },
  )
  return stdout
}
