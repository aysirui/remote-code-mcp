# 部署指南

本指南面向单 Gateway 实例部署。项目阶段和信任边界见 [README](../README.md) 与 [SECURITY.md](../SECURITY.md)。

## 环境配置

本地开发优先使用 `apps/server/.env.example`，Docker Compose 使用根目录 `.env.docker.example`。复制模板后填写真实配置，不要提交包含密钥的文件。

Server 环境变量优先级为：系统环境变量 → `apps/server/.env` → 根目录 `.env` → 默认值。服务、迁移及管理员初始化统一使用 `apps/server/src/config/env.ts`；执行数据库命令前务必确认目标库。

| 变量                                      | 用途及默认行为                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`                            | Server 数据库连接；Compose 根据 MySQL 配置构造                         |
| `APP_SECRET`                              | 必填，至少 32 字符的随机密钥                                           |
| `PUBLIC_URL`                              | Gateway 外部地址；本地默认 `http://localhost:3000`                     |
| `CONSOLE_URL`                             | Console 外部地址，也用于邮箱激活链接；本地默认 `http://localhost:5173` |
| `ADMIN_EMAIL`                             | 首个管理员邮箱；该地址不能通过公开注册获得管理员权限                   |
| `PORT`                                    | Server 端口，默认 3000；Compose 固定为 3000                            |
| `SMTP_HOST`、`SMTP_USER`、`SMTP_PASSWORD` | 注册激活邮件所需的 SMTP 地址、账号和密码 / 授权码                      |
| `SMTP_PORT`、`SMTP_SECURE`                | 默认 587 / false，强制 STARTTLS；465 使用 true，启用隐式 TLS           |
| `MAIL_FROM`                               | 可选，默认使用 `SMTP_USER`，须为服务商允许的发件地址                   |
| `MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`   | Compose 必填的数据库密码，使用不同的强密码                             |
| `VITE_API_URL`                            | Console 构建时使用的 API 地址；Compose 自动使用 `PUBLIC_URL`           |

若数据库密码含 URL 保留字符，`DATABASE_URL` 中的密码段需要 URL 编码。当前 Compose 直接插值 `MYSQL_PASSWORD` 构造连接串，应使用足够长且无需 URL 编码的随机密码，或自行调整连接串配置。

服务启动校验数据库、密钥、端口及 SMTP 配置，但不会主动连接 SMTP。数据库命令无需 SMTP 配置，管理员初始化还需要有效的 `ADMIN_EMAIL`。

## Docker Compose / Dokploy

本地准备 Compose 配置可使用：

```powershell
Copy-Item .env.docker.example .env
```

填写 `.env` 后，可在已配置反向代理的环境运行：

```sh
docker compose up -d --build
```

仓库 Compose 仅使用 `expose`，不向宿主机发布端口。独立使用 Compose 时，反向代理必须连接同一 Docker 网络；此命令本身不会提供公网域名和 HTTPS。MySQL 仅供内部服务访问。

在 Dokploy 中选择 **Docker Compose 应用**，连接仓库并使用根目录 `docker-compose.yml`。Environment 中配置 `.env.docker.example` 的全部必填变量，包括 SMTP；这些变量通过 Compose 显式传入容器。

在 Domains 中分别为 `server`（端口 3000）和 `console`（端口 80）配置域名及 HTTPS，对应 `PUBLIC_URL`、`CONSOLE_URL`。反向代理必须保留 `/agent/connect` 的 WebSocket Upgrade，允许 `/mcp` 的流式 HTTP 响应。推荐启用 Dokploy 的 Isolated Deployments，由其管理路由与网络。

Server 容器启动顺序：

1. 等待 MySQL healthcheck。
2. 确认镜像中存在已提交的 Drizzle 迁移日志；缺失时停止启动。
3. 执行尚未应用的数据库迁移。
4. 初始化管理员；已有管理员时不重建、不重置密码。
5. 启动 NestJS。

首次初始化会在 Server 部署日志中输出一次随机临时密码。限制日志权限和保留时间，首次登录后及时修改密码；改密会撤销会话，需要重新登录，且不会清除旧日志。

持久化并备份 `mysql_data` 数据卷，不要在重部署时删除。迁移 SQL、快照及 `meta/_journal.json` 随源码和镜像分发，无需单独挂载迁移目录。更新前备份数据库，核对目标提交及迁移；多副本部署需要改为单独执行迁移任务，当前方案不提供多实例 WSS 路由。

## 数据库迁移

首次安装及部署只执行已提交的迁移。开发中修改数据库结构时：

1. 修改 `apps/server/src/infrastructure/database/schema.ts`。
2. 在本地手动运行 `pnpm db:generate`。
3. 检查生成的 SQL、快照和 `meta/_journal.json`，与 Schema 一起提交。
4. 在隔离测试数据库执行 `pnpm db:migrate` 验证后，再安排目标环境升级。

不要手写或直接修改迁移文件，也不要在部署环境生成迁移。生产升级前应备份数据库并安排维护窗口，避免多个实例同时执行迁移。

## 注册与邮箱激活

普通注册需通过邮箱激活后才能登录，链接有效期 24 小时且只能使用一次。未激活账号可在注册流程选择重发，重发间隔 60 秒，旧链接失效。SMTP 接受邮件不保证到达收件箱，投递异常需检查垃圾邮件和供应商状态。

管理员初始化账号无需补充激活；激活邮箱不会解除管理员对账号的禁用。`CONSOLE_URL` 必须是收件人实际可访问的地址。

## 部署后验证

在独立测试环境验证，避免对生产库或私人工作区执行破坏性测试：

- `GET /health` 返回健康状态；OAuth 两个 `.well-known` 元数据入口可用。
- 未授权访问 `/mcp` 返回 401 和 `WWW-Authenticate`，OAuth 授权、刷新、重放拒绝及撤销符合预期。
- 两个用户只能访问自己的设备和工作区，管理员也不能通过 MCP 跨用户读文件。
- Runtime 离线、设备撤销、工作区停用、连接替换及断线重连后权限仍正确，旧凭据失效。
- 只读工作区拒绝写入，SHA-256 冲突被拒绝，路径穿越、敏感文件及链接绕过被拒绝。
- 临时命令需要本机审批；拒绝、超时或撤销后不会执行。Git 写入及高危递归删除保留审批。
- 真实 MySQL 并发下，授权码兑换、Refresh Token 消费、配对和撤销状态保持一致。
- 使用 MCP Inspector 和目标 MCP 客户端完成实际 OAuth / 工具调用，确认流式响应和 WebSocket 代理可用。
- 日志不含文件正文、完整命令参数、工作目录、令牌或审批详情。

源码检查和单元测试不能代替以上环境验证。OAuth 刷新诊断见 [使用指南](usage.md#oauth-客户端授权与刷新令牌)。
