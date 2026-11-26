import { readFileSync } from 'node:fs'
import path from 'node:path'
import { esc } from './oauth-utils'
import type { OAuthRedirectType } from './oauth-redirect'

// src 与 dist 的模块层级一致，资源随 Server 应用部署，无需额外前端构建或外部请求。
const assets = path.resolve(__dirname, '../../../assets/oauth')
const template = readFileSync(path.join(assets, 'consent.html'), 'utf8')
const logo = 'data:image/svg+xml;base64,' + readFileSync(path.join(assets, 'logo.svg')).toString('base64')
const favicon = 'data:image/svg+xml;base64,' + readFileSync(path.join(assets, 'favicon.svg')).toString('base64')

/** 服务端渲染授权模板：动态文本统一转义，隐藏字段由 Controller 生成并签名。 */
export function renderOAuthConsent(data: {
  clientName: string
  email: string
  target: string
  type: OAuthRedirectType
  fields: string
  csrf: string
  issuedAt: string
  signature: string
}): string {
  const values: Record<string, string> = {
    logo,
    favicon,
    clientName: esc(data.clientName),
    email: esc(data.email),
    target: esc(data.target),
    typeLabel: {
      https: '网页客户端',
      loopback: '本地回环',
      'custom-scheme': '本地应用深链',
    }[data.type],
    fields: data.fields,
    csrf: esc(data.csrf),
    issuedAt: esc(data.issuedAt),
    signature: esc(data.signature),
    returnHint: data.type === 'custom-scheme' ? '授权后浏览器将尝试打开本地客户端' : '授权后将返回客户端',
  }

  // 一次替换模板占位符，不递归解释用户输入；仅允许已定义的模板字段。
  return template.replace(/\{\{([a-zA-Z]+)\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(values, key)) throw Error('未知 OAuth 授权模板字段：' + key)
    return values[key]
  })
}
