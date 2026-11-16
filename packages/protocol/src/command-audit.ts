/** 日志只保留常见程序、任务及无值开关，其余参数默认隐藏，避免目录、凭据或脚本正文入库。 */
const programs = new Set([
  'pnpm',
  'npm',
  'npx',
  'yarn',
  'bun',
  'node',
  'deno',
  'python',
  'python3',
  'pip',
  'pip3',
  'uv',
  'cargo',
  'rustc',
  'go',
  'java',
  'javac',
  'mvn',
  'gradle',
  'dotnet',
  'make',
  'cmake',
  'tsc',
  'vue-tsc',
  'vite',
  'vitest',
  'jest',
  'eslint',
  'prettier',
])
const argumentsAllowed = new Set([
  'run',
  'exec',
  'test',
  'build',
  'typecheck',
  'lint',
  'format',
  'check',
  'dev',
  'start',
  'install',
  'ci',
  '--watch',
  '--fix',
  '--check',
  '--write',
  '--noEmit',
  '--runInBand',
  '--silent',
  '--verbose',
  '--version',
  '--help',
  '-v',
  '-h',
])

export interface CommandAudit {
  executable: string
  args: string[]
}

/** Runtime 在发送前脱敏，Gateway 持久化前再次调用；重复脱敏不会恢复任何原值。 */
export function sanitizeCommandAudit(command: CommandAudit): CommandAudit {
  const base =
    command.executable
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(?:exe|cmd)$/i, '')
      .toLowerCase() || ''
  // 未知参数可能声明后续值的含义（如 --token 或 -e），从此处起全部隐藏。
  let hideRest = !programs.has(base)
  return {
    executable: programs.has(base) ? base : '[已隐藏]',
    args: command.args.slice(0, 20).map((arg) => {
      if (!argumentsAllowed.has(arg)) hideRest = true
      return hideRest ? '[已隐藏]' : arg
    }),
  }
}

export function commandAuditSummary(command: CommandAudit): string {
  const safe = sanitizeCommandAudit(command)
  return [safe.executable, ...safe.args].join(' ')
}
