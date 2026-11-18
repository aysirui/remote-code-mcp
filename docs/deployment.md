# 部署指南

本指南面向单 Server 实例部署。项目阶段和信任边界见 [README](https://github.com/aysirui/remote-code-mcp/blob/main/README.md) 与 [SECURITY.md](https://github.com/aysirui/remote-code-mcp/blob/main/SECURITY.md)。

## 环境配置

本地开发优先使用 `apps/server/.env.example`，Docker Compose 使用 `docker/env.example` 作为通用配置模板。复制模板后填写真实配置，不要提交包含密钥的文件。

Server 环境变量优先级为：系统环境变量 → `apps/server/.env` → 根目录 `.env` → 默认值。服务、迁移及管理员初始化统一使用 `apps/server/src/config/env.ts`；执行数据库命令前务必确认目标库。

| 变量                                      | 用途及默认行为                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| `DATABASE_URL`                            | Server 数据库连接；Compose 根据 MySQL 配置构造                                    |
| `APP_SECRET`                              | 必填，至少 32 字符的随机密钥                                                      |
| `PUBLIC_URL`                              | Server 外部地址；本地默认 `http://localhost:3000`                                 |
| `CONSOLE_URL`                             | Console 外部地址，也用于邮箱激活链接；本地默认 `http://localhost:5173`            |
| `ADMIN_EMAIL`                             | 首个管理员邮箱；该地址不能通过公开注册获得管理员权限                              |
| `PORT`                                    | Server 端口，默认 3000；Compose 固定为 3000                                       |
| `SMTP_HOST`、`SMTP_USER`、`SMTP_PASSWORD` | 注册激活邮件所需的 SMTP 地址、账号和密码 / 授权码                                 |
| `SMTP_PORT`、`SMTP_SECURE`                | 默认 587 / false，强制 STARTTLS；465 使用 true，启用隐式 TLS                      |
| `MAIL_FROM`                               | 可选，默认使用 `SMTP_USER`，须为服务商允许的发件地址                              |
| `MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`   | Compose 必填的数据库密码，使用不同的强密码                                        |
| `VITE_API_URL`                            | Console 构建时使用的 API 地址；Compose 自动使用 `PUBLIC_URL`                      |
| `WEBSITE_URL`                             | 官网公开 URL，供 Astro 生成规范地址；默认使用 `PUBLIC_URL`                        |
| `DOCS_URL`                                | 在线文档完整 URL，供 Console 导航使用；默认 `${WEBSITE_URL:-${PUBLIC_URL}}/docs/` |
| `VITE_DOCS_URL`                           | Console 构建期文档地址，Compose 从 `DOCS_URL` 自动传入                            |
| `PUBLIC_SITE_URL`、`PUBLIC_CONSOLE_URL`   | Astro 构建期官网和控制台地址，由 Compose 自动注入                                 |

若数据库密码含 URL 保留字符，`DATABASE_URL` 中的密码段需要 URL 编码。当前 Compose 直接插值 `MYSQL_PASSWORD` 构造连接串，应使用足够长且无需 URL 编码的随机密码，或自行调整连接串配置。

服务启动校验数据库、密钥、端口及 SMTP 配置，但不会主动连接 SMTP。数据库命令无需 SMTP 配置，管理员初始化还需要有效的 `ADMIN_EMAIL`。

## Docker Compose / Dokploy

本地准备 Compose 配置可使用：

```powershell
Copy-Item docker/env.example .env
```

填写 `.env` 后，可在已配置反向代理的环境运行：

```sh
docker compose up -d --build
```

仓库 Compose 仅使用 `expose`，不向宿主机发布端口。独立使用 Compose 时，反向代理必须连接同一 Docker 网络；此命令本身不会提供公网域名和 HTTPS。MySQL 仅供内部服务访问。

在 Dokploy 中选择 **Docker Compose 应用**，连接仓库并使用根目录 `docker-compose.yml`。Environment 中按 `docker/env.example` 的说明配置全部必填变量，包括 SMTP；这些变量通过 Compose 显式传入容器。

在 Domains 中为 `server`（端口 3000）、`console`、`website`、`docs`（均为端口 80）配置公开入口。一个域名承载多个服务时，应按 Host 和路径匹配，确保 API、OAuth、MCP、WebSocket 以及文档路径不会被官网根路由覆盖。路由及 TLS 的具体实现由部署环境决定，对应 `PUBLIC_URL`、`CONSOLE_URL`。反向代理必须保留 `/agent/connect` 的 WebSocket Upgrade，允许 `/mcp` 的流式 HTTP 响应。推荐启用 Dokploy 的 Isolated Deployments，由其管理路由与网络。

### Traefik Labels 版本

仓库额外提供 **`docker-compose.traefik.yml`**，是一份完整的替代编排文件，与不包含路由 Labels 的 `docker-compose.yml` 二选一使用，**不要同时通过多个 `-f` 叠加这两个文件**。

此版本面向已有 Traefik 的自托管环境。**两份文件使用相同的运行参数、构建参数、默认值、数据库卷和五个服务共享的 `internal` 网络；Traefik 版仅为四个 Web 服务额外连接 `proxy` 网络并添加 Host、Path Labels。** 不提供或假设任何固定的反向代理拓扑：

- `SERVER_HOST`：RCM Server 域名，对应 `PUBLIC_URL` 的 Host；后端 `server:3000` 处理 MCP、OAuth、API、健康检查和 `/agent/connect` WebSocket。
- `CONSOLE_HOST`：Console 域名，对应 `CONSOLE_URL` 的 Host；代理到 `console:80`。
- `WEBSITE_HOST`：官网域名，对应 `WEBSITE_URL` 的 Host；`/docs` 和 `/docs/*` 优先交给 `docs:80`，其他官网路径交给 `website:80`，**不剥离 `/docs/` 前缀**。
- `TRAEFIK_NETWORK`：Traefik 和四个 Web 服务额外加入的**已存在外部 Docker 网络**，默认 `traefik-public`；五个服务仍保留相同的 `internal` 内网，MySQL 不加入 `proxy`。
- `TRAEFIK_ENTRYPOINT`：已有 Traefik 入口名，默认 `web`（HTTP）。此示例**不自动申请证书、不开启 TLS 也不配置 HTTPS 跳转**。如果由 Traefik 自行终止 HTTPS，应把入口改为正确的 TLS 入口，并按部署环境增加 Router TLS/证书配置；如果由上游网关终止 HTTPS，则应按实际上游与 Traefik 的安全边界配置。

`PUBLIC_URL`、`CONSOLE_URL`、`WEBSITE_URL`、`DOCS_URL` 是应用使用的**完整公开 URL**；`SERVER_HOST`、`CONSOLE_HOST`、`WEBSITE_HOST` 只填写**域名**（不含协议、端口或路径）。每一项 Host 与其对应的 URL 主机名必须一致；此示例要求 Server、Console、Website 使用互不相同的主机名，避免 Server 的全路径 Router 与官网冲突。官网与文档使用相同域名，`DOCS_URL` 应为 `${WEBSITE_URL}/docs/`。两套 Compose 中 Console 的 `VITE_DOCS_URL` 均默认使用 `DOCS_URL`，没有配置时依次回退 `WEBSITE_URL/docs/`、`PUBLIC_URL/docs/`；Website 的 `PUBLIC_SITE_URL` 均默认回退 `PUBLIC_URL`。实际独立域名部署请显式设置 `WEBSITE_URL` 和 `DOCS_URL`。

启动前创建/确认 Traefik 共享网络，确保 Traefik 自身已连接，并在 `.env` 中设置这些变量：

```sh
docker network create traefik-public
docker compose -f docker-compose.traefik.yml config
docker compose -f docker-compose.traefik.yml up -d --build
```

如果网络已存在，跳过 `docker network create`；自定义 `TRAEFIK_NETWORK` 时替换上述网络名。先检查 `config` 输出的 Host 匹配、端口和网络，再部署。示例不发布宿主机端口，不包含 Traefik 容器，也不应与部署平台自动生成的同名路由重复配置；已有路由应先统一归属，避免冲突。

Server 容器启动顺序：

1. 等待 MySQL healthcheck。
2. 确认镜像中存在已提交的 Drizzle 迁移日志；缺失时停止启动。
3. 执行尚未应用的数据库迁移。
4. 初始化管理员；已有管理员时不重建、不重置密码。
5. 启动 NestJS。

首次初始化会在 Server 部署日志中输出一次随机临时密码。限制日志权限和保留时间，首次登录后及时修改密码；改密会撤销会话，需要重新登录，且不会清除旧日志。

持久化并备份 `mysql_data` 数据卷，不要在重部署时删除。迁移 SQL、快照及 `meta/_journal.json` 随源码和镜像分发，无需单独挂载迁移目录。更新前备份数据库，核对目标提交及迁移；多副本部署需要改为单独执行迁移任务，当前方案不提供多实例 WSS 路由。

## 官网与在线文档

产品官网由 `apps/website` 使用 Astro 静态生成，在线文档由根目录 `docs/` 使用 VitePress 生成；两者均采用独立 Docker 镜像，不依赖 Console 的构建与发布。

构建时可通过 `WEBSITE_URL` 配置官网公开地址，`DOCS_URL` 配置控制台导航使用的在线文档绝对地址。官网控制台按钮使用 `CONSOLE_URL`，文档默认公共路径为 `/docs/`。请设置公开访问地址，不要填写容器内部地址或密钥。

建议的公开路径为：官网 `/`、文档 `/docs/`、MCP `/mcp`、REST API `/api/*`、OAuth `/oauth/*`，Console 使用独立域名。代理层需要保留 OAuth 元数据发现路径、健康检查和 WebSocket Upgrade，同时支持 MCP 流式响应。

长命令和细分错误码建议先升级 Server，再升级 Runtime；旧 Runtime 的成功响应不会被重新解读为失败。要支持最长命令及审批，检查 MCP 客户端、反向代理和上游网关对 `/mcp` 的等待限制是否能覆盖 Server 的 25 分钟 15 秒预算及网络余量。若调用仍在约 30 秒中断，分别检查客户端和代理，不要仅提高 Runtime 的命令超时。

本地运行 `pnpm dev:website` 开发官网，`pnpm docs:dev` 开发文档。运行 `pnpm docs:build` 生成文档；根目录 `pnpm build` 同时包含官网与文档构建。

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
- 官网根路径正确展示产品入口，Console 和 GitHub 按钮有效；文档 `/docs` 跳转至 `/docs/`，未登录可阅读、搜索并直接刷新页面，未知文档路径返回 HTTP 404；控制台登录及现有页面保持可用。
- 未授权访问 `/mcp` 返回 401 和 `WWW-Authenticate`，OAuth 授权、刷新、重放拒绝及撤销符合预期。
- 两个用户只能访问自己的设备和工作区，管理员也不能通过 MCP 跨用户读文件。
- Runtime 离线、设备撤销、工作区停用、连接替换及断线重连后权限仍正确，旧凭据失效。
- 只读工作区拒绝写入，SHA-256 冲突被拒绝，路径穿越、敏感文件及链接绕过被拒绝。
- 临时命令需要本机审批；拒绝、超时或撤销后不会执行。Git 写入及高危递归删除保留审批。
- 真实 MySQL 并发下，授权码兑换、Refresh Token 消费、配对和撤销状态保持一致。
- 使用 MCP Inspector 和目标 MCP 客户端完成实际 OAuth / 工具调用，确认流式响应和 WebSocket 代理可用。
- 日志不含文件正文、完整命令参数、工作目录、令牌或审批详情。

源码检查和单元测试不能代替以上环境验证。OAuth 刷新诊断见 [使用指南](usage.md#oauth-客户端授权与刷新令牌)。
