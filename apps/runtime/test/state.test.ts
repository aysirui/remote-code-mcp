import {
  activeServer,
  addServer,
  authorizeWorkspace,
  migrateConfig,
  normalizeGateway,
  selectServer,
  serverWorkspaces,
  workspaceViews,
  type Config,
} from '../src/workspace/state'

let config: Config
beforeEach(() => {
  config = migrateConfig({
    gateway: 'https://rcm.example.com',
    deviceId: 'remote-device',
    deviceToken: 'remote-token',
    name: '开发电脑',
    workspaces: [
      {
        id: 'existing-workspace',
        name: '项目',
        root: '/projects/demo',
        enabled: true,
        permissions: { read: true, write: true },
        policies: { file: 'allow', git: 'approval', command: 'deny' },
        commands: [{ id: 'check', name: '检查', executable: 'node', args: ['--version'] }],
      },
    ],
  })
})

test('旧配置迁移保留设备凭据、工作区 ID 和原授权，重复读取不会生成新身份', () => {
  const server = activeServer(config)
  expect(server.deviceId).toBe('remote-device')
  expect(server.deviceToken).toBe('remote-token')
  expect(serverWorkspaces(config)).toEqual([
    expect.objectContaining({
      id: 'existing-workspace',
      root: '/projects/demo',
      policies: { file: 'allow', git: 'approval', command: 'deny' },
      permissions: { read: true, write: true },
    }),
  ])
  const reloaded = migrateConfig(JSON.parse(JSON.stringify(config)))
  expect(reloaded).toEqual(config)
  expect(reloaded.workspaces[0].commands?.[0].id).toBe('check')
})

test('切换本地与远程服务器并重载配置后恢复各自的设备身份和权限', () => {
  const remote = activeServer(config)
  const local = addServer(config, 'http://localhost:3000', '本地开发')
  local.deviceId = 'local-device'
  local.deviceToken = 'local-token'
  authorizeWorkspace(local, config.workspaces[0].id)
  selectServer(config, local.id)
  expect(activeServer(config).deviceToken).toBe('local-token')
  const reloaded = migrateConfig(JSON.parse(JSON.stringify(config)))
  selectServer(reloaded, remote.id)
  expect(activeServer(reloaded).deviceToken).toBe('remote-token')
  expect(serverWorkspaces(reloaded)[0].policies).toEqual({
    file: 'allow',
    git: 'approval',
    command: 'deny',
  })
  selectServer(reloaded, local.id)
  expect(serverWorkspaces(reloaded)[0].permissions.write).toBe(false)
})

test('新增服务器默认没有工作区访问权限，不继承其他服务器的写入授权', () => {
  const local = addServer(config, 'http://localhost:3000')
  selectServer(config, local.id)
  expect(serverWorkspaces(config)).toEqual([])
  expect(workspaceViews(config)[0]).toMatchObject({
    authorized: false,
    enabled: false,
    permissions: { read: false, write: false },
  })
})

test('同一目录在不同服务器使用独立权限和远程 ID，重复授权保持原 ID', () => {
  const remote = activeServer(config)
  const local = addServer(config, 'http://localhost:3000')
  const grant = authorizeWorkspace(local, config.workspaces[0].id)
  expect(grant.id).not.toBe(remote.workspaces[0].id)
  expect(authorizeWorkspace(local, config.workspaces[0].id)).toBe(grant)
  grant.permissions.write = true
  grant.policies.file = 'approval'
  remote.workspaces[0].permissions.write = false
  expect(grant.permissions.write).toBe(true)
  expect(serverWorkspaces(config, remote)[0].permissions.write).toBe(false)
})

test('取消授权立即停止暴露工作区，重新授权保留 ID 但恢复只读审批', () => {
  const server = activeServer(config)
  const grant = server.workspaces[0]
  grant.authorized = false
  expect(serverWorkspaces(config)).toEqual([])
  const restored = authorizeWorkspace(server, config.workspaces[0].id)
  expect(restored.id).toBe('existing-workspace')
  expect(restored.permissions).toEqual({ read: true, write: false })
  expect(restored.policies).toEqual({ file: 'approval', git: 'allow', command: 'approval' })
})

test('重复添加规范化后相同的地址复用原配置，不覆盖名称和配对凭据', () => {
  const server = activeServer(config)
  expect(addServer(config, 'https://RCM.example.com:443/', '另一个名称')).toBe(server)
  expect(config.servers).toHaveLength(1)
  expect(server.deviceToken).toBe('remote-token')
  expect(normalizeGateway('http://localhost:3000/')).toBe('http://localhost:3000')
})

test.each([
  'http://remote.example.com',
  'https://example.com/mcp',
  'https://user:pass@example.com',
  'https://example.com?token=x',
])('拒绝错误服务器地址 %s', (gateway) => {
  expect(() => addServer(config, gateway)).toThrow()
  expect(config.servers).toHaveLength(1)
})
