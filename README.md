# Remote Code MCP

让 MCP 客户端在你授权的范围内，通过远程 Gateway 访问本机代码工作区。

Remote Code MCP（RCM）是一个可自行部署的 TypeScript monorepo，包含云端 Gateway、Web Console、本机 Runtime 和共享协议。Runtime 主动建立出站 WebSocket 连接，无需将本机工作区的服务端口暴露到公网。

**项目处于早期开发阶段。** 支持源码构建和单 Gateway 实例的 Docker Compose 部署。部署前请按 [部署指南](docs/deployment.md) 验证目标环境及 MCP 客户端兼容性，并了解 [安全边界与已知限制](SECURITY.md)。

## 能做什么

- **远程访问代码**：浏览、读取、搜索和修改已授权的工作区文件。
- **Git 协作**：查看状态、历史和差异，以及经本机审批执行暂存和提交。
- **命令执行**：运行内置或本机登记命令；临时程序和参数必须经过本机单次审批。
- **本机管理授权**：为各服务器独立设置工作区读写权限及 File / Git / Command 策略，处理待审批操作。
- **多用户管理**：账号注册与邮箱激活、设备配对、OAuth 客户端授权及脱敏操作记录。

命令以 Runtime 进程账号权限执行，可能访问工作区外的文件和网络。审批、超时和进程树清理不构成 OS 沙箱。使用前请阅读 [安全说明](SECURITY.md)。

## 架构

```text
MCP 客户端
    │ HTTPS / MCP Streamable HTTP / OAuth 2.0
    ▼
Server（NestJS Gateway） ── MySQL（Drizzle）
    ▲          ▲
    │ WSS      │ HTTPS
    │          Console（Vue Web 管理台）
Runtime（本机 Node.js 服务）
    ├── 本地管理 API + Vue UI（127.0.0.1）
    └── 已授权 Workspace → File / Git / Command
```

Server 验证用户、设备及工作区归属，Runtime 再按本机授权核验请求。工作区绝对路径保留在本机；文件内容和操作参数经 Gateway 转发，不作为 Server / Console 的持久化业务数据。操作审计仅保存允许的脱敏元数据。Gateway 能接触转发内容，请只连接你信任的服务器。

| 目录                | 职责                                                     |
| ------------------- | -------------------------------------------------------- |
| `apps/server`       | NestJS Gateway、账号与 OAuth、设备连接、MCP 工具及数据库 |
| `apps/console`      | Vue 管理台：账号、设备、工作区快照、客户端授权及管理功能 |
| `apps/runtime`      | 本机连接、目录授权、操作执行、本地 API 和内置 Web UI     |
| `packages/protocol` | RPC、操作定义、Zod Schema 和共享类型                     |
| `docker`            | Server / Console 镜像与启动配置                          |

## 快速开始

需要 Node.js 22+、pnpm 10.15.0（见 `packageManager`）、Git、MySQL 8.4，以及用于注册激活邮件的 SMTP 服务。Docker Compose 部署另见 [部署文档](docs/deployment.md)。

以下命令从仓库根目录执行，环境文件复制示例使用 PowerShell：

```powershell
git clone https://github.com/aysirui/remote-code-mcp.git
cd remote-code-mcp
corepack enable
pnpm install --frozen-lockfile
Copy-Item apps/server/.env.example apps/server/.env
Copy-Item apps/console/.env.example apps/console/.env.local
```

macOS / Linux 可使用 `cp` 复制上述环境文件。修改 `apps/server/.env`，设置测试数据库的 `DATABASE_URL`、随机 `APP_SECRET`（至少 32 字符）、`ADMIN_EMAIL` 和 SMTP 配置。先创建空的开发数据库，再执行仓库中已提交的迁移：

```sh
pnpm db:migrate
pnpm admin:init
pnpm --filter @rcm/protocol build
```

管理员初始化会显示一次随机临时密码，首次登录后需修改。首次运行不需要生成迁移；只有修改数据库 Schema 时才运行 `pnpm db:generate`。

分别在三个终端启动：

```sh
# Gateway：http://localhost:3000
pnpm dev:server
```

```sh
# Console：http://localhost:5173
pnpm dev:console
```

```sh
# Runtime：构建 Node 程序和本地 Web UI，再启动
pnpm --filter @rcm/runtime build
pnpm --filter @rcm/runtime start
```

打开 Runtime 日志中的完整本地管理链接，添加服务器并完成设备配对，再授权一个测试工作区。具体流程、命令策略和多服务器管理见 [使用指南](docs/usage.md)。

MCP 接入地址为 `https://你的服务器域名/mcp`，使用平台账号进行 OAuth 授权。公网 Gateway 必须使用 HTTPS，反向代理需支持 `/agent/connect` 的 WebSocket Upgrade。各客户端兼容性需要实测，建议先用 MCP Inspector 验证。

## MCP 工具

所有工作区工具都需要 `workspaceId`，可通过 `workspace_list` 获取。实际可执行范围由本机工作区权限和策略决定。

| 工具                                                   | 用途                                   |
| ------------------------------------------------------ | -------------------------------------- |
| `device_list`、`workspace_list`                        | 列出当前用户的设备和已授权工作区       |
| `file_list`、`file_read`、`file_search`                | 浏览目录、读取文件及 SHA-256、搜索文本 |
| `file_write`、`file_mkdir`、`file_move`、`file_delete` | 写入、创建目录、移动和删除             |
| `git_status`、`git_log`、`git_diff`                    | 查看状态、提交历史和未暂存差异         |
| `git_add`、`git_commit`                                | 暂存和提交，始终需要本机审批           |
| `command_list`、`command_run`                          | 查询登记命令、运行登记或临时命令       |

覆盖已有文件须提供当前 `expectedSha256`；命令执行需要工作区写权限。工具输入和输出契约以 [共享协议](packages/protocol/src/mcp-tools.ts) 为准。

## 文档与贡献

Console 部署后可通过同域名的 `/docs/` 公开访问在线文档，登录页面和控制台侧栏均提供“使用文档”入口。文档随 Console 镜像构建和发布，修改 `docs/*.md` 后重新构建镜像即可更新。

本地运行 `pnpm docs:dev` 后访问 `http://127.0.0.1:5174/docs/`；与 `pnpm dev:console` 同时运行时，Console 的文档入口也可用。单独构建与预览使用 `pnpm docs:build` 和 `pnpm docs:preview`；根目录 `pnpm build` 已包含文档构建。

- [使用指南](docs/usage.md)：配对、工作区、审批、命令和 OAuth 排查。
- [部署指南](docs/deployment.md)：环境配置、Docker Compose / Dokploy、迁移和上线验证。
- [贡献指南](CONTRIBUTING.md)：开发流程、检查命令及提交要求。
- [安全说明与漏洞报告](SECURITY.md)：信任边界、已知限制和报告方式。
- [项目协作规范](AGENTS.md)：模块职责、代码约束和迁移规则。

欢迎通过 Issue 反馈问题或通过 Pull Request 提交改进。请勿在公开 Issue 中上传密钥、工作区源码或未公开的漏洞利用细节。

## 许可证

本项目采用 [GNU Affero General Public License v3.0 only（AGPL-3.0-only）](LICENSE)，允许商业使用。分发受许可覆盖的版本时需履行对应源码提供义务；修改本程序并通过网络提供服务时，须按第 13 条向远程交互用户提供该修改版本的对应源码。

Copyright (C) 2026 安阳市思锐科技有限责任公司。

上述公司版权声明适用于公司拥有版权的原创部分；第三方依赖、素材及外部贡献的权利归属和许可声明应予保留。开源许可不转移版权，也不授予冒用公司名称、商标或声称官方背书的权利。

用户通过 RCM 访问的工作区代码，不会仅因使用本工具而自动受 AGPL 约束。许可范围、分叉及 SaaS 场景见 [许可证说明](docs/licensing.md)；完整且具有约束力的条款以 `LICENSE` 为准。在适用法律允许的范围内，本项目按现状提供，不附带任何担保。
