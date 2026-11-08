import fs from 'node:fs'
const required = [
  'package.json',
  'pnpm-workspace.yaml',
  'docker-compose.yml',
  'README.md',
  'packages/protocol/src/index.ts',
  'apps/server/src/main.ts',
  'apps/server/src/core.ts',
  'apps/server/src/oauth.ts',
  'apps/server/src/mcp.ts',
  'apps/server/src/controllers.ts',
  'apps/server/src/schema.ts',
  'apps/console/src/main.ts',
  'apps/console/src/App.vue',
  'apps/runtime/src/main.ts',
  'apps/runtime/src/executors.ts',
  'apps/runtime/web/src/App.vue',
]
let failed = false
for (const f of required) {
  if (!fs.existsSync(f)) {
    console.error('MISSING', f)
    failed = true
  } else console.log('OK', f)
}
for (const f of [
  'package.json',
  'apps/server/package.json',
  'apps/runtime/package.json',
  'apps/console/package.json',
  'packages/protocol/package.json',
]) {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch (e) {
    failed = true
    console.error('INVALID JSON', f, e)
  }
}
if (failed) process.exit(1)
console.log('Structure check passed (not a substitute for dependency build/tests).')
