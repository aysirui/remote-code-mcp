import {
  SpawnCommandExecutionProvider,
  commandExecutionProvider,
} from '../src/operations/command/command-provider'
import type { CommandExecutionRequest } from '../src/operations/command/command-provider'
import { execPath } from 'node:process'

const provider = new SpawnCommandExecutionProvider()
const request = (
  args: string[],
  overrides: Partial<CommandExecutionRequest> = {},
): CommandExecutionRequest => ({
  executable: execPath,
  args,
  cwd: process.cwd(),
  env: { ...process.env },
  timeoutMs: 3000,
  outputLimitBytes: 1024,
  ...overrides,
})

test('默认后端可运行本机命令', async () => {
  await expect(
    commandExecutionProvider.run(request(['-e', 'process.stdout.write("local-ok")'])),
  ).resolves.toMatchObject({ exitCode: 0, output: 'local-ok' })
})

test('明确声明普通 spawn 不提供 OS 级隔离', () => {
  expect(provider.capabilities).toEqual({
    processTreeTermination: 'best-effort',
    filesystemIsolation: false,
    networkIsolation: false,
    resourceLimits: false,
  })
})

test('执行固定程序并返回退出码和输出', async () => {
  const result = await provider.run(request(['-e', 'process.stdout.write("provider-ok")']))
  expect(result).toEqual({
    exitCode: 0,
    output: 'provider-ok',
    truncated: false,
    timedOut: false,
  })
})

test('限制合并输出长度并标记截断', async () => {
  const result = await provider.run(
    request(['-e', 'process.stdout.write("x".repeat(2048))'], { outputLimitBytes: 128 }),
  )
  expect(result.exitCode).toBe(0)
  expect(result.output).toHaveLength(128)
  expect(result.truncated).toBe(true)
})

test('超时后终止命令并返回超时标记', async () => {
  const result = await provider.run(
    request(['-e', 'process.stdout.write("before-timeout"); setTimeout(() => {}, 5000)'], {
      timeoutMs: 1000,
    }),
  )
  expect(result.timedOut).toBe(true)
  expect(result.output).toBe('before-timeout')
})

test('多字节命令输出按 UTF-8 字节限制，截断时不切开字符', async () => {
  const result = await provider.run(
    request(['-e', 'process.stdout.write(String.fromCodePoint(0x4e2d).repeat(50))'], {
      outputLimitBytes: 8,
    }),
  )
  expect(result).toMatchObject({ output: '中中', truncated: true })
})
