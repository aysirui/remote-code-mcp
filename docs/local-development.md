---
title: 本地运行与 ngrok 公网接入
description: 从源码在本机启动 Remote Code MCP Server、Console 和 Runtime，通过 ngrok HTTPS 隧道连接 AI 客户端，无需使用官方在线 MCP 服务或购买云服务器。
---

<script setup>
import LocalArchitectureDiagram from './.vitepress/theme/components/LocalArchitectureDiagram.vue'
</script>

# 本地运行与 ngrok 公网接入

除了直接使用官方在线 MCP Server 和在服务器上私有化部署，也可以在自己的电脑上运行完整的 RCM 服务，再通过 ngrok 提供公网 HTTPS 入口。适合个人试用、功能开发、MCP 客户端兼容性测试以及临时远程编码。

此方式不依赖官方 RCM 账号、在线 Server 或 Console，但仍依赖 ngrok 的网络服务和所选 AI 客户端。电脑、Server、Console、Runtime 和隧道必须保持运行。无需购买云服务器或域名；隧道的可用性、费用与流量限制以服务商实际套餐为准。

::: warning 使用范围
这是源码运行及临时公网联调方案，不是生产部署方案。Vite 开发服务器会公开开发资源，仅在隔离的测试环境中短期使用，不要暴露真实业务数据、数据库端口或 Runtime 本地管理端口。长期公开提供服务请参考 [私有化部署](./deployment.md)。
:::

## 工作原理

<LocalArchitectureDiagram />

ngrok 应转发 Console 的 5173 端口，而不是直接转发 Server 的 3000 端口。这样 Console 登录、OAuth 授权与 MCP 请求使用同一个公开域名，避免浏览器登录 Cookie 不共享。Runtime 可以直接连接本机 Server。

## 1. 准备运行环境

- Node.js 22 或更高版本、pnpm（仓库指定版本为 10.15.0）、Git。
- MySQL 8.4，创建独立的本地测试数据库及有权限的数据库账号。
- SMTP 配置：Server 启动时检查必填项，普通用户注册和激活需要实际可用的邮件服务。
- ngrok 账号及 CLI，可访问支持远程 MCP 和 OAuth 的 AI 客户端。

除克隆仓库及进入目录外，以下命令均从仓库根目录执行。命令默认显示 Linux Shell，可切换至 Windows PowerShell；macOS 通常可使用 Shell 版本。

::: code-group

```sh [Linux Shell]
git clone https://github.com/aysirui/remote-code-mcp.git
cd remote-code-mcp
corepack enable
pnpm install --frozen-lockfile
cp apps/server/.env.example apps/server/.env
cp apps/console/.env.example apps/console/.env.local
```

```powershell [Windows PowerShell]
git clone https://github.com/aysirui/remote-code-mcp.git
cd remote-code-mcp
corepack enable
pnpm install --frozen-lockfile
Copy-Item apps/server/.env.example apps/server/.env
Copy-Item apps/console/.env.example apps/console/.env.local
```

:::

若已有环境文件，请直接编辑，不要覆盖已有配置。

## 2. 启动 ngrok 并取得公开地址

从 [ngrok 官方下载页面](https://ngrok.com/download) 安装对应系统的 CLI。登录 [Authtoken 页面](https://dashboard.ngrok.com/get-started/your-authtoken)，复制自己的 Token。

::: code-group

```sh [Linux Shell]
ngrok config add-authtoken "你的Authtoken"
ngrok config check
ngrok http 5173
```

```powershell [Windows PowerShell]
ngrok config add-authtoken "你的Authtoken"
ngrok config check
ngrok http 5173
```

:::

记录终端 Forwarding 中实际分配的 HTTPS 地址。本文统一以 `https://example.ngrok-free.app` 为示例，请全部替换为自己的地址。此时本地服务尚未启动，请求暂时失败是正常的。

## 3. 配置 Server

编辑 `apps/server/.env`，保留模板中的其他必填配置：

```dotenv
PORT=3000
PUBLIC_URL=https://example.ngrok-free.app
CONSOLE_URL=https://example.ngrok-free.app
WEBSITE_URL=https://example.ngrok-free.app

DATABASE_URL=mysql://rcm:change-me@127.0.0.1:3306/remote_code_mcp_test
APP_SECRET=REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARS
ADMIN_EMAIL=admin@example.com
```

替换数据库连接、管理员邮箱、随机密钥以及 SMTP 配置，示例密码不可直接使用。可通过以下命令生成随机密钥：

::: code-group

```sh [Linux Shell]
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

```powershell [Windows PowerShell]
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

:::

`PUBLIC_URL` 是 OAuth 元数据、MCP Resource 和原文件下载地址的公开来源，不要添加 `/mcp`。本方案中 `CONSOLE_URL` 与其完全相同。`WEBSITE_URL` 暂时指向同一入口，不代表产品官网已经单独启动。

## 4. 配置 Console

编辑 `apps/console/.env.local`：

```dotenv
VITE_API_URL=https://example.ngrok-free.app
VITE_PROXY_TARGET=http://localhost:3000
```

| 变量              | 用途                                         |
| ----------------- | -------------------------------------------- |
| VITE_API_URL      | 对外 MCP 地址、OAuth 回跳校验及生产 API 地址 |
| VITE_PROXY_TARGET | Vite 开发代理实际连接的本地 Server 地址      |

不要将代理目标设置成 ngrok 地址，否则请求可能循环转发。Vite 自动允许配置的公开 API 主机，并保留浏览器真实 Origin 和 Referer。若存在更高优先级的环境变量或 `.env.development.local`，确保没有覆盖以上配置。

## 5. 初始化数据库和启动应用

确认 `DATABASE_URL` 指向独立的测试库后执行：

::: code-group

```sh [Linux Shell]
pnpm --filter @rcm/protocol --filter @rcm/bot-sdk build
pnpm db:migrate
pnpm admin:init
```

```powershell [Windows PowerShell]
pnpm --filter @rcm/protocol --filter @rcm/bot-sdk build
pnpm db:migrate
pnpm admin:init
```

:::

管理员初始化会输出一次随机临时密码，首次登录后必须修改。已有管理员不会被重置。仅运行现有迁移，不需要生成新的迁移文件。

分别打开终端启动 Server、Console 和 Runtime：

::: code-group

```sh [Linux Shell]
pnpm dev:server
```

```powershell [Windows PowerShell]
pnpm dev:server
```

:::

::: code-group

```sh [Linux Shell]
pnpm dev:console
```

```powershell [Windows PowerShell]
pnpm dev:console
```

:::

::: code-group

```sh [Linux Shell]
# 独立 Runtime 数据目录和管理端口，避免影响已运行的正式 Runtime。
RUNTIME_DATA_DIR="$HOME/.remote-code-mcp-dev" RUNTIME_PORT=18788 pnpm dev:runtime
```

```powershell [Windows PowerShell]
# 独立 Runtime 数据目录和管理端口，避免影响已运行的正式 Runtime。
$env:RUNTIME_DATA_DIR = Join-Path $HOME '.remote-code-mcp-dev'
$env:RUNTIME_PORT = '18788'
pnpm dev:runtime
```

:::

确认 Console 实际监听 5173；如果端口已占用，应先停止旧进程或调整隧道目标。不要直接将 Runtime 管理端口开放到公网。

## 6. 登录 Console 并配对 Runtime

1. 浏览器访问 `https://example.ngrok-free.app/login`，使用本地初始化的管理员账号登录并完成首次改密，再重新登录。
2. 打开 Runtime 日志输出的完整本地管理链接，添加 Server 地址 `http://localhost:3000`。
3. 按 [Runtime 使用指南](./usage.md) 完成配对及工作区授权，使用公网 Console 页面和本地账号确认配对。
4. 在 Console 检查设备在线状态，先添加不含敏感信息的只读测试工作区。

本地账号、设备、工作区与官方平台完全独立。不要混用官方 Console 或官方 MCP 地址。公网联调期间必须通过 ngrok 域名登录 Console，不要先通过 localhost 登录再跳到公网域名。

## 7. 接入 AI 客户端

在 AI 客户端中创建独立的测试 MCP 配置，不需要修改官方服务的已有连接：

| 配置项         | 值                                 |
| -------------- | ---------------------------------- |
| MCP Server URL | https://example.ngrok-free.app/mcp |
| 传输方式       | Streamable HTTP                    |
| 认证方式       | OAuth                              |

按 [ChatGPT](./connect-chatgpt.md)、[WorkBuddy](./connect-workbuddy.md) 或 [豆包](./connect-doubao.md) 的接入步骤完成授权，将其中官方地址替换为实际 ngrok 地址。客户端必须支持相应的远程 MCP 和 OAuth 能力。

授权时浏览器应进入自己的 ngrok 域名，确认授权后返回客户端。首次调用建议使用 `device_list`、`workspace_list` 和 `file_read` 验证只读访问，然后再按需启用写入权限。

## 8. 验证连接及文件流

在终端执行（替换示例域名）：

::: code-group

```sh [Linux Shell]
curl -i https://example.ngrok-free.app/health
curl -i https://example.ngrok-free.app/.well-known/oauth-protected-resource
curl -i https://example.ngrok-free.app/.well-known/oauth-authorization-server
curl -i -X POST https://example.ngrok-free.app/mcp
```

```powershell [Windows PowerShell]
curl.exe -i https://example.ngrok-free.app/health
curl.exe -i https://example.ngrok-free.app/.well-known/oauth-protected-resource
curl.exe -i https://example.ngrok-free.app/.well-known/oauth-authorization-server
curl.exe -i -X POST https://example.ngrok-free.app/mcp
```

:::

健康检查与元数据应返回 200；未授权 POST /mcp 应返回 401 并包含 WWW-Authenticate。OAuth 元数据中的公开地址必须为当前隧道域名。

通过 MCP Inspector 或目标客户端执行文本读取、图片预览和原文件流读取。原文件流返回的一次性地址必须使用同一 OAuth 客户端的有效令牌访问，并比较下载文件与原文件的 SHA-256。服务端支持文件流不代表所有 AI 客户端都支持自动下载和解析原文件，具体见 [文件读写](./usage.md#文件读写)。

## 9. 常见问题

| 问题                         | 排查方法                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| ngrok ERR_NGROK_9009         | 检查 HTTP_PROXY、HTTPS_PROXY 等环境变量和 ngrok proxy_url 配置；显式代理可能需要付费套餐。             |
| ngrok 无法建立连接           | 执行 ngrok diagnose，检查网络、DNS 和服务可用性。                                                      |
| ngrok 返回 502               | 检查 Vite 是否启动、实际监听端口是否为 5173。                                                          |
| Vite Blocked request         | 确认 VITE_API_URL 为实际隧道域名并重启 Console，不要开放任意 Host。                                    |
| 登录返回 Invalid origin      | 确认 Server 的 PUBLIC_URL、CONSOLE_URL 与浏览器 Origin 一致，使用公网域名登录。                        |
| 登录后反复跳转               | 检查 Cookie 是否属于当前公网域名、VITE_API_URL 是否与 OAuth 回跳域名一致，以及账号是否已完成首次改密。 |
| OAuth 元数据仍指向 localhost | 检查 Server 环境变量优先级并重启 Server。                                                              |
| Runtime 离线                 | 检查本地 Server、设备配对及 Runtime 连接状态。                                                         |
| 文件流下载失败               | 检查一次性地址是否过期、令牌是否属于原客户端、隧道是否支持该传输及客户端是否实际发起下载。             |

ngrok 的本地调试界面通常为 `http://127.0.0.1:4040`。可以检查请求状态、OAuth 注册及 Token 兑换是否成功，但不要分享包含密码、Cookie、令牌、文件正文或授权码的请求记录。若遇到 ngrok 浏览器警告页，应核对实际域名和响应内容，不要关闭 RCM 安全校验。

## 10. 停止服务或更换域名

测试结束后关闭 ngrok，再停止本地 Server、Console 和 Runtime。关闭隧道不会删除本地数据库和工作区。

若重新启动 ngrok 后域名变化，需要同步修改 Server 和 Console 环境变量、重启应用，并更新 AI 客户端的 MCP 地址，重新完成必要的 OAuth 授权。

对于长期使用、多人共享和稳定公网访问，请使用 [私有化部署](./deployment.md)，或者直接使用官方在线 MCP 服务。
