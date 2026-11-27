import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { DeviceHub } from '../device/device-hub'
import type { Store } from '../../infrastructure/database/store'
import { register } from './tools/register'
import { deviceList } from './tools/device/list'
import { workspaceList } from './tools/workspace/list'
import { fileList } from './tools/file/list'
import { fileStat } from './tools/file/stat'
import { fileRead } from './tools/file/read'
import { fileSearch } from './tools/file/search'
import { fileWrite } from './tools/file/write'
import { fileMkdir } from './tools/file/mkdir'
import { fileMove } from './tools/file/move'
import { fileDelete } from './tools/file/delete'
import { filePreview, filePreviewResource } from './tools/file/preview'
import { gitStatus } from './tools/git/status'
import { gitLog } from './tools/git/log'
import { gitDiff } from './tools/git/diff'
import { gitAdd } from './tools/git/add'
import { gitCommit } from './tools/git/commit'
import { commandList } from './tools/command/list'
import { commandRun } from './tools/command/run'

/** 为当前用户与客户端注册工具，保留领取文件地址时的签发授权复查。 */
export function registerMcpTools(
  server: McpServer,
  hub: DeviceHub,
  store: Store,
  userId: string,
  clientId: string,
  authorizeTransfer: () => Promise<void>,
) {
  const context = { hub, store, userId, clientId, authorizeTransfer }
  const { name, uri, mimeType, description, text } = filePreviewResource
  server.registerResource(name, uri, { mimeType, description }, async () => ({
    contents: [{ uri, mimeType, text }],
  }))

  register(server, deviceList, context)
  register(server, workspaceList, context)

  register(server, fileList, context)
  register(server, fileStat, context)
  register(server, fileRead, context)
  register(server, fileSearch, context)
  register(server, fileWrite, context)
  register(server, fileMkdir, context)
  register(server, fileMove, context)
  register(server, fileDelete, context)
  register(server, filePreview, context)

  register(server, gitStatus, context)
  register(server, gitLog, context)
  register(server, gitDiff, context)
  register(server, gitAdd, context)
  register(server, gitCommit, context)

  register(server, commandList, context)
  register(server, commandRun, context)
}
