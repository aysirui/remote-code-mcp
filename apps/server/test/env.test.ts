import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Env } from '../src/config/env'

describe('Server 环境配置', () => {
  test('企微结果卡使用官网首页，不能把控制台路径或查询参数带入链接', () => {
    expect(new Env({ WEBSITE_URL: 'https://www.example.com/path?from=test' }, []).websiteUrl).toBe(
      'https://www.example.com/',
    )
    expect(new Env({ PUBLIC_URL: 'https://rcm.example.com/api' }, []).websiteUrl).toBe(
      'https://rcm.example.com/',
    )
  })
  let directory: string
  let localFile: string
  let rootFile: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'rcm-env-'))
    localFile = path.join(directory, 'server.env')
    rootFile = path.join(directory, 'root.env')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test('系统环境变量优先，本地文件优先于根目录文件，缺失项逐级补全', () => {
    writeFileSync(
      localFile,
      'DATABASE_URL=mysql://local/test\nPUBLIC_URL=https://local.example.com\n',
    )
    writeFileSync(
      rootFile,
      'DATABASE_URL=mysql://root/test\nPUBLIC_URL=https://root.example.com\nCONSOLE_URL=https://console.example.com\nPORT=4000\n',
    )
    const config = new Env({ DATABASE_URL: 'mysql://system/test' }, [localFile, rootFile])
    expect(config.databaseUrl).toBe('mysql://system/test')
    expect(config.publicUrl).toBe('https://local.example.com')
    expect(config.consoleUrl).toBe('https://console.example.com')
    expect(config.port).toBe(4000)
    expect(new Env({}, [localFile, rootFile]).databaseUrl).toBe('mysql://local/test')
  })

  test('本地文件不存在时仍加载根目录文件，支持带引号的值与注释', () => {
    writeFileSync(rootFile, 'DATABASE_URL="mysql://root/test" # 测试数据库\n')
    expect(new Env({}, [localFile, rootFile]).databaseUrl).toBe('mysql://root/test')
  })

  test('仅使用环境变量即可启动，无需创建 .env 文件', () => {
    const config = new Env(
      {
        DATABASE_URL: 'mysql://system/test',
        APP_SECRET: 's'.repeat(32),
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'sender@example.com',
        SMTP_PASSWORD: 'password',
      },
      [localFile, rootFile],
    )
    expect(() => config.validateServer()).not.toThrow()
    expect(config.publicUrl).toBe('http://localhost:3000')
    expect(config.consoleUrl).toBe('http://localhost:5173')
    expect(config.port).toBe(3000)
    expect(config.adminEmail).toBe('')
  })

  test('已设置为空的环境变量也不会被文件覆盖，缺少必填配置时给出明确错误', () => {
    writeFileSync(localFile, 'DATABASE_URL=mysql://local/test\nAPP_SECRET=' + 's'.repeat(32))
    const config = new Env({ DATABASE_URL: '', APP_SECRET: '' }, [localFile])
    expect(() => config.databaseUrl).toThrow('DATABASE_URL')
    expect(() => config.appSecret).toThrow('APP_SECRET')
  })

  test('数据库命令不依赖服务密钥，管理员邮箱统一规范化', () => {
    const config = new Env(
      { DATABASE_URL: 'mysql://system/test', ADMIN_EMAIL: '  ADMIN@Example.com  ' },
      [],
    )
    expect(config.databaseUrl).toBe('mysql://system/test')
    expect(config.adminEmail).toBe('admin@example.com')
    expect(() => config.validateServer()).toThrow('APP_SECRET')
  })

  test('拒绝不足 32 字符的密钥', () => {
    expect(() => new Env({ APP_SECRET: 's'.repeat(31) }, []).appSecret).toThrow('APP_SECRET')
  })

  test.each(['abc', '0', '-1', '65536', '3000.5', 'Infinity', ' '])('拒绝非法端口 %s', (port) => {
    expect(() => new Env({ PORT: port }, []).port).toThrow('PORT')
  })

  test.each(['1', '65535'])('接受有效端口边界 %s', (port) => {
    expect(new Env({ PORT: port }, []).port).toBe(Number(port))
  })
})

test('启动必须具备 SMTP 配置，默认 587 使用 STARTTLS 且允许显式发件地址', () => {
  const base = { DATABASE_URL: 'mysql://system/test', APP_SECRET: 's'.repeat(32) }
  expect(() => new Env(base, []).validateServer()).toThrow('SMTP_HOST')
  const config = new Env(
    {
      ...base,
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'user@example.com',
      SMTP_PASSWORD: 'password',
      MAIL_FROM: 'noreply@example.com',
    },
    [],
  )
  expect(() => config.validateServer()).not.toThrow()
  expect(config.mail).toMatchObject({ port: 587, secure: false, from: 'noreply@example.com' })
})
