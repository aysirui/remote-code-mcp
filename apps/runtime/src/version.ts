import { readFileSync } from 'node:fs'
import path from 'node:path'

// 开发入口在 src，构建入口在 dist/server；版本统一取自 Runtime 的 package.json。
const packageFile = path.resolve(
  __dirname,
  path.basename(__dirname) === 'src' ? '../package.json' : '../../package.json',
)
export const runtimeVersion: string = JSON.parse(readFileSync(packageFile, 'utf8')).version
