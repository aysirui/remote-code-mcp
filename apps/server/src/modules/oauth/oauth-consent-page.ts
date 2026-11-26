import { esc } from './oauth-utils'
import type { OAuthRedirectType } from './oauth-redirect'

/** 授权确认页面：所有外部文本转义，隐藏字段由 Controller 生成并签名。 */
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
  const typeLabel = {
    https: '网页客户端',
    loopback: '本地回环',
    'custom-scheme': '本地应用深链',
  }[data.type]
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>授权 AI 客户端 · Remote Code MCP</title>
    <style>
      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 28px 16px;
        background: radial-gradient(ellipse at 50% 0,#e0eaff,transparent 62%),#f5f7fb;
        color: #17243a;
        font: 15px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      }

      .shell {
        width: 100%;
        max-width: 480px;
      }

      .brand {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        margin-bottom: 22px;
        font-weight: 700;
        letter-spacing: .01em;
      }

      .mark {
        display: grid;
        place-items: center;
        width: 36px;
        height: 36px;
        background: #2359df;
        color: white;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 800;
      }

      .card {
        background: #fff;
        border: 1px solid #e1e7f0;
        border-radius: 12px;
        padding: 30px;
        box-shadow: 0 20px 60px #233e6b12;
      }

      .eyebrow {
        font-size: 12px;
        color: #526886;
        font-weight: 650;
        letter-spacing: .08em;
      }

      h1 {
        font-size: 25px;
        line-height: 1.35;
        letter-spacing: -.03em;
        margin: 8px 0 10px;
      }

      p {
        margin: 0;
        color: #52627a;
      }

      .client {
        font-weight: 700;
        color: #17243a;
        overflow-wrap: anywhere;
      }

      .details {
        margin: 23px 0;
        background: #f7f9fc;
        border: 1px solid #e7edf5;
        border-radius: 8px;
        padding: 4px 15px;
      }

      .item {
        padding: 12px 0;
      }

      .item+.item {
        border-top: 1px solid #e4eaf2;
      }

      .label {
        display: block;
        color: #62738b;
        font-size: 12px;
        margin-bottom: 3px;
      }

      .value {
        font-size: 14px;
        font-weight: 600;
        overflow-wrap: anywhere;
      }

      .tag {
        display: inline-block;
        background: #e7eefc;
        color: #2855a9;
        border-radius: 4px;
        padding: 2px 7px;
        font-size: 11px;
        margin-left: 6px;
      }

      .permissions {
        margin-bottom: 22px;
      }

      .permissions h2 {
        font-size: 14px;
        margin: 0 0 8px;
      }

      .permissions p {
        font-size: 13px;
      }

      .notice {
        border-left: 3px solid #e6a23c;
        background: #fff9ed;
        border-radius: 0 6px 6px 0;
        padding: 10px 12px;
        font-size: 12px;
        color: #78551a;
        margin-bottom: 20px;
      }

      button {
        width: 100%;
        border: 0;
        border-radius: 8px;
        padding: 14px;
        background: #2459df;
        color: #fff;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }

      button:hover {
        background: #1948c5;
      }

      button:focus-visible {
        outline: 3px solid #91b1ff;
        outline-offset: 3px;
      }

      .cancel {
        text-align: center;
        margin-top: 12px;
        font-size: 12px;
      }

      .foot {
        text-align: center;
        color: #62738b;
        font-size: 12px;
        margin: 18px 0 0;
      }

      @media(max-width:420px) {
        .card {
          padding: 22px;
        }
        h1 {
          font-size: 22px;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="brand">
        <span class="mark" aria-hidden="true">RCM</span>
        Remote Code MCP
      </header>
      <section class="card" aria-labelledby="heading">
        <div class="eyebrow">安全授权 · OAUTH 2.0</div>
        <h1 id="heading">连接 AI 客户端</h1>
        <p><span class="client">${esc(data.clientName)}</span> 请求访问你的 RCM 工作区工具。</p>
        <div class="details">
          <div class="item">
            <span class="label">当前登录账号</span>
            <div class="value">${esc(data.email)}</div>
          </div>
          <div class="item">
            <span class="label">授权回调 <span class="tag">${typeLabel}</span></span>
            <div class="value">${esc(data.target)}</div>
          </div>
        </div>
        <section class="permissions">
          <h2>授权范围 · mcp:tools</h2>
          <p>客户端可请求已授权工作区的文件、Git 和命令工具。实际操作仍受 Runtime 的权限与审批策略限制。</p>
        </section>
        <div class="notice">客户端名称由其自行提供。请确认发起授权的应用及回调地址可信后再继续。</div>
        <form method="POST" action="/oauth/authorize">
          ${data.fields}
          <input type="hidden" name="csrf" value="${esc(data.csrf)}">
          <input type="hidden" name="issued_at" value="${esc(data.issuedAt)}">
          <input type="hidden" name="consent_sig" value="${esc(data.signature)}">
          <button type="submit">同意授权并继续 →</button>
        </form>
        <p class="cancel">不希望授权？关闭此页面即可取消。</p>
      </section>
      <p class="foot">${data.type === 'custom-scheme' ? '授权后浏览器将尝试打开本地客户端' : '授权后将返回客户端'} · Remote Code MCP</p>
    </main>
  </body>
</html>`
}
