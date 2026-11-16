import { applyWorkspaceRevocations, type ServerProfile } from '../src/workspace/state'

/** Server 撤销远程授权时，不应影响同一设备的其他工作区。 */
test('仅删除匹配的远程授权 ID', () => {
  const server: ServerProfile = {
    id: 'server-1',
    name: 'test',
    gateway: 'https://example.com',
    paused: false,
    workspaces: [
      {
        workspaceId: 'local-1',
        id: 'remote-1',
        authorized: true,
        enabled: true,
        permissions: { read: true, write: false },
        policies: { file: 'allow', git: 'allow', command: 'allow' },
      },
      {
        workspaceId: 'local-2',
        id: 'remote-2',
        authorized: true,
        enabled: true,
        permissions: { read: true, write: false },
        policies: { file: 'deny', git: 'deny', command: 'deny' },
      },
    ],
  }
  expect(applyWorkspaceRevocations(server, ['remote-1', 'not-found'])).toEqual(['remote-1'])
  expect(server.workspaces.map((grant) => grant.id)).toEqual(['remote-2'])
  expect(applyWorkspaceRevocations(server, ['remote-1'])).toEqual([])
})

test('空撤销列表不改变现有授权', () => {
  const server: ServerProfile = {
    id: 'server-1',
    name: 'test',
    gateway: 'https://example.com',
    paused: false,
    workspaces: [],
  }
  expect(applyWorkspaceRevocations(server, [])).toEqual([])
  expect(server.workspaces).toEqual([])
})
