# Remote Code MCP · Node.js 多用户远程本地代码工具平台

> **状态：可运行的 MVP 源代码 / 未完成端到端验证。** 项目包含主要应用源码和部署配置，但生成环境无法访问 npm Registry，尚未完成真实依赖安装、TypeScript 全量类型检查、数据库迁移及 ChatGPT OAuth 端到端测试。首次正式上线前必须完成下方验收流程和安全审计。不要把它当作已经过生产安全认证的成品。

## 1. 架构

```
ChatGPT --MCP HTTPS + OAuth--> NestJS Gateway --WSS--> Local Node.js Runtime --fs/git--> Authorized Workspace
                                     |                        |
                                MySQL 8                Vue3 local UI
                                     |
                             Vue3 Web Console
```

- `apps/server`: NestJS + Drizzle + MySQL，平台账号、OAuth 授权码 + PKCE、动态客户端注册 DCR、设备配对、管理 API、MCP Streamable HTTP 与 WSS RPC。
- `apps/console`: Vue3 + Element Plus，用户账户、设备管理、工作区查看、MCP 连接引导、管理员用户/设备/审计界面。
- `apps/runtime`: 无桌面框架的 Node.js Runtime，WebSocket 出站连接，本地 Vue3 管理界面与 `file.list/read/search/write`、`git.status/diff`。
- `packages/protocol`: RPC Schema、操作类型与 Zod 数据校验。

**边界：** 云端只同步工作区 ID、名称、权限及设备状态，不存储本地绝对路径；文件内容经 Gateway 中转并返回 AI 客户端，不做云端持久化。Gateway 管 OAuth 和设备路由，Runtime 在本地再次检查工作区权限。管理员没有跨用户读源码权限。

## 2. 环境要求

Node.js 22+、pnpm 10+、MySQL 8.4、Git、Docker/Compose（部署时）。当前按全新开发项目初始化数据库，不维护旧库兼容逻辑。

## 3. 本地开发启动

```bash
corepack enable
cp .env.example .env
cp apps/console/.env.example apps/console/.env.local
# 修改 .env 的 APP_SECRET、DATABASE_URL、ADMIN_EMAIL
pnpm install
```

启动 MySQL：

```bash
# 可使用现有 MySQL 8，也可 docker run --name rcm-mysql -e MYSQL_DATABASE=remote_code_mcp ...
# 在空的开发数据库中初始化当前 Schema
pnpm db:generate
pnpm db:migrate
pnpm admin:init
```

分别启动：

```bash
pnpm --filter @rcm/protocol build
pnpm dev:server                       # http://localhost:3000
pnpm dev:console                      # http://localhost:5173
pnpm --filter @rcm/runtime build      # 构建 Node 程序和内置的 Vue 界面
pnpm --filter @rcm/runtime start      # 打印本地 UI 地址（带一次性启动访问密钥）
```

> `runtime dev` 在首次 UI 构建前可能没有静态界面；建议先执行 `runtime build`，之后使用 `runtime start`。Runtime 默认保存设置到 `~/.remote-code-mcp/config.json`（Unix 使用权限 0600）。

### 首个管理员

在 `.env` 配置 `ADMIN_EMAIL=admin@example.com`。完成 Drizzle 数据库迁移后，**在受控终端中**执行一次（上述初始化流程已包含）：

```bash
pnpm admin:init
```

初始化脚本创建一个 `super_admin`，生成随机临时密码，使用 bcrypt 存入数据库；临时密码只会在该交互式终端显示一次，不会写入普通服务日志。非交互式容器启动同样会将临时密码输出到首次部署日志中。管理员首次登录 Console 会被要求修改密码，随后需重新登录。重复执行不重置现有管理员。普通注册永远不能凭 `ADMIN_EMAIL` 提权，且该邮箱禁止普通注册。

### Runtime 配对

1. 打开启动日志打印的本地 UI URL，例如 `http://127.0.0.1:18787/#token=...`，**不要分享其中的 token**。
2. 在本地 UI 确定 Gateway URL（本机可用 `http://localhost:3000`；公网必须 `https://...`）。
3. 点击 **绑定设备**，获得临时配对码。
4. 打开 `http://localhost:5173/activate`，用平台账号登录，输入配对码并确认。
5. 返回本地 UI 点击“我已确认，完成绑定”。
6. 点击 **添加项目**，使用目录浏览器选择一个临时测试项目。默认只读；开启写入权限后，每个工作区可独立选择 **逐次审批**（默认，每次文件写入需在本地 30 秒内确认）或 **自动写入**（明确确认后无需逐次审批）。
   可在对应工作区点击 **添加命令**，登记命令 ID、显示名称、可执行程序和固定参数。AI 使用 `command_list` 查询可用 ID，再通过 `command_run` 请求执行；无论写入策略如何，命令均须本地逐次批准。`git_status` / `git_diff` 保持独立只读工具。
7. Web Console 会显示绑定设备和同步工作区。

### MCP Inspector

ChatGPT OAuth 接入前，建议先验证：

- `GET /health` 返回 `{ok:true}`。
- `GET /.well-known/oauth-protected-resource` 返回资源元数据。
- `GET /.well-known/oauth-authorization-server` 返回 OAuth 授权服务元数据。
- `POST /mcp` 无 Token 返回 401 和 `WWW-Authenticate`。
- OAuth 客户端可完成 DCR → Authorization Code + PKCE → Token，并在请求 `/mcp` 时使用 Bearer Token。
- 调用 `device_list`、`workspace_list`、`file_read` 和 `git_status`。

**ChatGPT 连接方式**：在 ChatGPT 中添加自定义 MCP Server（服务器 URL），输入 `https://mcp.example.com/mcp`，使用 OAuth 授权同一个平台账号。该版本实现的是 DCR public OAuth client + PKCE 的最小闭环；未实现 CIMD 与完整认证服务的合规性测试；已实现 Refresh Token 一次性轮换，但尚需与 ChatGPT 做端到端互操作测试。ChatGPT 的实际连接行为可能需要补充标准兼容适配。

## 4. Dokploy 一键部署（Docker Compose）

**选择 Dokploy 的 Docker Compose 应用，而不是 Docker Stack。** 连接 Git 仓库并指定仓库根目录的 `docker-compose.yml`；Dokploy 会根据 Compose 构建镜像和启动服务。

在 Dokploy 的 Environment 中设置：

```env
MYSQL_PASSWORD=your-long-random-password
MYSQL_ROOT_PASSWORD=your-different-random-password
APP_SECRET=your-cryptographically-random-secret-at-least-32-characters
ADMIN_EMAIL=admin@example.com
PUBLIC_URL=https://mcp.example.com
CONSOLE_URL=https://console.example.com
```

必须在 Dokploy 的 **Domains** 中分别给 `server`（容器端口 `3000`）与 `console`（容器端口 `80`）设置域名和 HTTPS，并为 `/agent/connect` 保留 WebSocket Upgrade。推荐启用 Dokploy 的 **Isolated Deployments**，由 Dokploy 为各服务生成 Traefik 路由与网络配置。Compose 仅使用 `expose`，不将这两个服务的端口映射到公网或宿主机；MySQL 仅在内部网络可达。

**第一次部署或重新部署只需点击 Deploy，不需要手动执行数据库或管理员命令。** Server 启动顺序：

1. 等待 MySQL healthcheck 通过。
2. 校验 Docker 镜像已包含 Git 提交的 `apps/server/drizzle/meta/_journal.json` 与迁移 SQL；缺失时启动失败。
3. `drizzle-kit migrate` 自动执行尚未应用的迁移，数据库记录执行进度。
4. `admin:init` 检查 `super_admin` 是否存在：首次创建随机临时密码，重复部署不重建账号、不重置密码。
5. 全部成功后启动 NestJS。

部署只需要持久化 `mysql_data` 数据卷。迁移文件、Drizzle 的 `meta/_journal.json` 和 Schema 快照全部提交 Git 并随 Server 镜像部署，不挂载迁移目录的 Volume。不要在重新部署时删除数据库卷。

首次部署时，Server 会在 Dokploy 的容器部署日志中**输出一次**超级管理员邮箱与随机临时密码。请在首次部署后及时记录并登录 Console 修改密码。后续重部署检测到管理员存在时仅跳过初始化，**不会重新生成、打印或重置密码**。日志中的初始密码不会因为改密而自动消失，建议限制 Dokploy 日志查看权限和保留期限，避免将部署日志发送到公共日志平台。

**迁移开发规范**：在本地修改 `apps/server/src/schema.ts` 后执行 `pnpm db:generate`，检查生成的 `apps/server/drizzle/` 下 SQL、`meta/_journal.json` 与快照，将其与 Schema 一起提交 Git。Dokploy 只执行 `db:migrate`，绝不在容器中生成或改写迁移历史。部署前务必确认迁移文件已提交。单实例应用适用当前启动流程；未来多副本部署应改为独立的一次性迁移 Job。

Dokploy 对 Compose 环境变量的处理是：Environment 面板的变量会供 Compose 插值，但不会自动注入所有容器；这里需要的变量已经在 `docker-compose.yml` 的 `environment` 显式声明。改变环境变量后重新部署即可。

## 4.1 本地开发

本地修改 Schema 时执行 `pnpm db:generate` 并提交迁移文件。Docker Compose / Dokploy 部署时会自动执行 `db:migrate` 和 `admin:init`，无需每次手工操作。

## 5. MCP 工具

| 名称             | 功能                                            | 默认权限      |
| ---------------- | ----------------------------------------------- | ------------- |
| `device_list`    | 当前 OAuth 用户设备状态                         | Authenticated |
| `workspace_list` | 当前 OAuth 用户可用工作区                       | Authenticated |
| `file_list`      | 目录列表                                        | Read          |
| `file_read`      | 文件内容 + SHA-256                              | Read          |
| `file_search`    | 按字面字符串搜索                                | Read          |
| `file_write`     | 新建/覆盖 UTF-8 文件；覆盖须提供 expectedSha256 | Write         |
| `git_status`     | 工作区 Git 状态                                 | Read          |
| `git_diff`       | 未暂存 Git Diff                                 | Read          |

MCP 返回同时具有 TextContent 和（对于对象数据）structuredContent，不声明 outputSchema，以提高不同 MCP Host 的兼容性。

## 5.1 OAuth 客户端授权与刷新令牌

- OAuth 授权关系保存在 `oauth_grants`，与一小时有效期的 Access Token 独立；Console 的“已授权 AI 客户端”不再因 Access Token 过期而隐藏。
- 授权码 + PKCE 成功兑换后返回 `access_token`（3600 秒）和 `refresh_token`（最长 30 天）；支持 `POST /oauth/token` 使用 `grant_type=refresh_token`、`client_id`、`refresh_token` 换取新的 Access Token 和 Refresh Token。
- Refresh Token 服务端只保存 SHA-256 摘要，每次刷新原子消费旧令牌并发放新令牌；再次使用已消费令牌视为重放并撤销同一 Token family。过期、撤销或检测到重放后需要重新进行授权。
- 用户可通过 Console 撤销某客户端授权，服务端同时撤销该客户端已有 Access/Refresh Token。授权数据按用户+客户端隔离。
- 服务端在标准输出记录结构化 OAuth 安全事件（不含 code、token、PKCE、Cookie、CSRF、请求体）；拒绝请求会附带 `request_id` 方便定位。发生在 BunkerWeb 的拦截需要结合 WAF 日志判断。
- 数据库部署使用新的 `0001_oauth_grants_refresh` 增量迁移，并回填历史未撤销的 Token 对应的客户端授权关系，但不会延长旧 Token 的有效期，也不会为旧 Token 补发 Refresh Token。旧客户端若已过期需重新完成 OAuth 授权。
- **无感刷新由客户端发起**：RCM 提供标准 Refresh Token 协议，具备自动刷新实现的 MCP 客户端可自行续期；不能保证所有 ChatGPT 客户端版本都自动使用 Refresh Token，需做实际兼容验证。
- 部署后验证：授权码兑换得到两种 Token；过期 Access Token 返回 401；刷新成功后新 Access Token 可使用；旧 Refresh Token 再次使用被拒绝；Console 撤销后 Access/Refresh Token 均被拒绝；重复并发刷新不可同时成功。

## 6. 安全约束与已知限制

### 已实现的基础防护

- Web Console 使用服务器 Session Cookie + CSRF 双重提交令牌，登录/注册/设备配对入口有进程内粗粒度限速。
- OAuth 使用授权码 + PKCE S256、令牌 Hash 存储、资源受众和 scope 校验、客户端 Redirect URI 精确匹配、5 分钟授权码过期。
- Runtime 与 Gateway 独立设备凭据认证；设备撤销后 Gateway 关闭 WSS 连接。
- Gateway 根据 Token 确认用户身份并限制工作区归属，管理员不具备代码读取后门。
- Runtime 只对本地明确注册的工作区操作，默认只读；阻止常见路径穿越、符号链接和敏感路径。工作区写入模式仅存于本地：旧配置默认逐次审批，关闭写权限后会重置为逐次审批。自动写入仍需要本地读写授权、Gateway 云端权限与文件 SHA-256 版本校验。
- 远程 MCP 不接受任意 Shell 文本或自定义可执行程序参数；`command_run` 只能选择本地 Runtime 登记的命令 ID，并要求逐次审批。自定义命令可执行项目代码，不构成 OS 沙箱，务必以最低权限账户运行。
- Runtime 本地管理 API 只监听 127.0.0.1，要求随机 Bearer Token 和 Origin 检查。

### 生产上线前必须补充或强化

1. **OAuth 合规**：使用成熟 OAuth Provider 替代 MVP 内置授权服务，完成 CIMD/DCR、RFC 8707、PKCE、刷新 Token、撤销、状态参数、授权页防重放等完整互操作测试。授权码兑换已增加行锁和事务，但仍需真实数据库并发测试。
2. **认证安全**：邮箱验证、密码找回、MFA、账号锁定、IP/设备风控、会话失效与管理员审计；超级管理员现通过独立初始化命令创建并强制首次修改密码；邮箱验证等仍未实现。
3. **运行时文件安全**：硬化 `file_write` 的符号链接/TOCTOU 竞态与原子替换，完善 Windows ACL / 路径处理；禁止在特权账户下运行。当前仅实现基本检查，不能视为完整文件系统沙箱。
4. **管理 API**：全接口权限审计、请求配额、签名设备凭据和密钥轮换、并发限制、连接抖动恢复、一次性配对状态机的数据库并发回归测试。
5. **分布式/稳定性**：WSS 多实例路由、任务持久化、消息去重、断线后的写入幂等、超时取消与完整失败审计。首版仅支持单 Gateway 实例。
6. **UI/客户端交付**：Runtime 安装程序、开机自启、自动升级、系统凭据库、管理员 MFA、工作区 Diff 审批。Runtime 已添加文件写入前的本地逐次确认（30 秒超时），但尚无完整 Diff 审批；目前使用 Node CLI 启动、浏览器管理界面，不是签名安装包。
7. **测试**：真实 MySQL、OAuth 客户端、MCP Inspector、ChatGPT、跨平台与浏览器 E2E 测试尚未通过。

因此本工程是一个**包含全部核心模块代码的 MVP 骨架**，不是未经人工验证即可安全对公网用户开放的成熟服务。

## 7. 质量与部署验收清单

```bash
pnpm install
pnpm --filter @rcm/protocol build
pnpm --filter @rcm/server build
pnpm --filter @rcm/console build
pnpm --filter @rcm/runtime build
pnpm test
```

然后至少验证：

- 用户 A、B 各连接一台 Runtime，只能列出并读取自己的工作区。
- Runtime 断开后返回 `DEVICE_OFFLINE`，而不是卡住。
- 设备解绑后旧凭据被拒绝，云端不可再路由到该设备。
- 只读工作区禁止 `file_write`。
- 覆盖文件时 SHA-256 不匹配返回冲突。
- 尝试读取 `../`、`.env`、`.ssh` 等被拒绝。
- OAuth Code PKCE 错误、无效 Audience、跨用户 Workspace ID 被拒绝。
- 管理员无法通过普通 MCP Tool 读取其他用户的文件。
- MCP Inspector、ChatGPT 都能正确返回 `file_read` 结构化数据。

## 8. 源码与配置

- `apps/server/src/schema.ts`：Drizzle 数据库模型。
- `apps/server/src/identity.ts` / `store.ts` / `device-hub.ts`：身份、持久化与设备 RPC 分层（`core.ts` 仅统一导出）。
- `apps/server/src/auth.controller.ts` / `account.controller.ts` / `admin.controller.ts` / `pairing.controller.ts`：按身份、用户、管理员、配对拆分的 API。
- `apps/server/src/oauth.ts`：MVP OAuth 授权服务。
- `apps/server/src/mcp.ts`：MCP Streamable HTTP / Tools。
- `apps/runtime/src/executors.ts`：工具调度与授权；文件/Git 安全操作分别位于 `file-operations.ts`、`git-operations.ts`、`path-safety.ts`。
- `apps/runtime/src/main.ts`：设备 WSS 生命周期；`local-server.ts` 负责 localhost API 与 Vue 静态资源，`write-approvals.ts` 负责本地审批。
- `apps/console/src/App.vue`：平台 UI 模板；`use-console.ts` 负责页面逻辑，`api.ts` 使用 Axios 与 CSRF。
- `apps/runtime/web/src/App.vue`：Runtime 本地 UI 模板；`use-runtime-console.ts` 负责逻辑，`http.ts` 使用 Axios。

LICENSE: 代码可作为自有项目进一步开发。请自行检查依赖项许可和部署环境的法律合规要求。

开发时的完整模块职责与中文注释约定详见 [CODE_STRUCTURE.md](CODE_STRUCTURE.md)。
