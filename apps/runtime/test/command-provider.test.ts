import { SpawnCommandExecutionProvider, commandExecutionProvider } from '../src/command-provider'
import type { CommandExecutionRequest } from '../src/command-provider'
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

test('默认后端本身拒绝执行，不能绕过上层能力检查', async () => {
  await expect(commandExecutionProvider.run(request(['-e', 'process.exit(0)']))).rejects.toThrow(
    'COMMAND_ISOLATION_REQUIRED',
  )
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
    request(['-e', 'setTimeout(() => process.stdout.write("late"), 5000)'], {
      timeoutMs: 100,
    }),
  )
  expect(result.timedOut).toBe(true)
})
