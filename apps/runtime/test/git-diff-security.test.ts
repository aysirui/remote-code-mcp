import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gitDiff } from '../src/operations/git/git-operations'
import { isSensitive } from '../src/operations/file/path-safety'

let workspaceRoot: string
const workspace = () => ({
  id: 'git-diff-security-test',
  name: 'Git Diff security test',
  root: workspaceRoot,
  enabled: true,
  permissions: { read: true, write: false },
  policies: { file: 'allow', git: 'allow', command: 'deny' } as const,
})

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'rcm-git-diff-'))
  execFileSync('git', ['init'], { cwd: workspaceRoot })
  execFileSync('git', ['config', 'user.name', 'Runtime Test'], { cwd: workspaceRoot })
  execFileSync('git', ['config', 'user.email', 'runtime-test@example.invalid'], {
    cwd: workspaceRoot,
  })
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
})

test('shared sensitive-name rules recognize secret file extensions regardless of case', () => {
  expect(isSensitive('client.PEM')).toBe(true)
  expect(isSensitive('identity.P12')).toBe(true)
  expect(isSensitive('private.key')).toBe(true)
  expect(isSensitive('README.md')).toBe(false)
})

test('Git diff excludes sensitive directories, filenames and extensions', async () => {
  await mkdir(path.join(workspaceRoot, '.aws'), { recursive: true })
  await mkdir(path.join(workspaceRoot, '.kube'), { recursive: true })
  await mkdir(path.join(workspaceRoot, 'secrets'), { recursive: true })
  await mkdir(path.join(workspaceRoot, 'certs'), { recursive: true })
  await writeFile(path.join(workspaceRoot, '.aws', 'credentials'), 'AWS_SECRET_BASELINE')
  await writeFile(path.join(workspaceRoot, '.kube', 'config'), 'KUBE_SECRET_BASELINE')
  await writeFile(path.join(workspaceRoot, 'secrets', 'token.json'), 'APP_SECRET_BASELINE')
  await writeFile(path.join(workspaceRoot, 'certs', 'client.crt'), 'CERT_SECRET_BASELINE')
  await writeFile(path.join(workspaceRoot, '.npmrc'), 'NPM_TOKEN_BASELINE')
  await writeFile(path.join(workspaceRoot, 'id_rsa'), 'SSH_PRIVATE_KEY_BASELINE')
  await writeFile(path.join(workspaceRoot, 'private.PEM'), 'PEM_PRIVATE_KEY_BASELINE')
  await writeFile(path.join(workspaceRoot, 'README.md'), 'ordinary baseline')

  execFileSync(
    'git',
    [
      'add',
      '-f',
      '--',
      '.aws',
      '.kube',
      'secrets',
      'certs',
      '.npmrc',
      'id_rsa',
      'private.PEM',
      'README.md',
    ],
    { cwd: workspaceRoot },
  )
  execFileSync('git', ['commit', '-m', 'Create baseline'], { cwd: workspaceRoot })

  await writeFile(path.join(workspaceRoot, '.aws', 'credentials'), 'AWS_SECRET_CHANGED')
  await writeFile(path.join(workspaceRoot, '.kube', 'config'), 'KUBE_SECRET_CHANGED')
  await writeFile(path.join(workspaceRoot, 'secrets', 'token.json'), 'APP_SECRET_CHANGED')
  await writeFile(path.join(workspaceRoot, 'certs', 'client.crt'), 'CERT_SECRET_CHANGED')
  await writeFile(path.join(workspaceRoot, '.npmrc'), 'NPM_TOKEN_CHANGED')
  await writeFile(path.join(workspaceRoot, 'id_rsa'), 'SSH_PRIVATE_KEY_CHANGED')
  await writeFile(path.join(workspaceRoot, 'private.PEM'), 'PEM_PRIVATE_KEY_CHANGED')
  await writeFile(path.join(workspaceRoot, 'README.md'), 'ordinary changed')

  const diff = await gitDiff(workspace())
  expect(diff).toContain('ordinary changed')
  for (const secret of [
    'AWS_SECRET_CHANGED',
    'KUBE_SECRET_CHANGED',
    'APP_SECRET_CHANGED',
    'CERT_SECRET_CHANGED',
    'NPM_TOKEN_CHANGED',
    'SSH_PRIVATE_KEY_CHANGED',
    'PEM_PRIVATE_KEY_CHANGED',
  ]) {
    expect(diff).not.toContain(secret)
  }
})
