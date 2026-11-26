---
title: Runtime 使用指南
description: 配置和配对 Remote Code MCP Runtime，授权本地工作区、登记开发命令、切换服务器和管理 MCP 客户端的 OAuth 授权。
---

# Runtime 使用指南

使用 RCM 在线 MCP Server 服务，只需在存放代码的设备上启动 Runtime。先前往 [官方控制台](https://rcmconsole.aysirui.com/) 注册或登录账号。

## 安装并启动 Runtime

本机需要 Node.js 22+、pnpm 10.15.0 和 Git。在终端执行：

```sh
git clone https://github.com/aysirui/remote-code-mcp.git
cd remote-code-mcp
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @rcm/protocol build
pnpm --filter @rcm/runtime build
pnpm --filter @rcm/runtime start
```

启动后打开终端打印的完整本地管理链接，按下文配对官方 Server。

首次接入请参考 [AI 工具接入指南](./connect-clients.md)。读写权限、审批和数据流向参见[工作区权限说明](./workspace-permissions.md)。

## Runtime 配置

Runtime 默认保存配置到 `~/.remote-code-mcp/config.json`。可通过进程环境变量指定 `RUNTIME_DATA_DIR`（私有数据目录）、`RUNTIME_PORT`（默认 18787）及首次配置的 `SERVER_URL`（官方服务填写 `https://rcm.aysirui.com`；首次添加服务器时也可直接在本地界面填写）。Runtime 不自动读取 `.env`，需在启动进程前设置这些变量；已有服务器配置通过本地 UI 管理，不受地址环境变量影响。

### 本地管理 Token

直接启动 Runtime 即可，不用手动设置 Token。每次启动时，Runtime 都会生成随机的本地管理 Token，并在终端打印完整的 `Local UI:` 链接（例如 `http://127.0.0.1:18787/#token=...`）。浏览器页面读取链接片段，再通过 `Authorization: Bearer` 请求本地管理 API。它不是配对后的设备 Token，也不是 Console 的登录凭据。

回环地址只限制请求来自本机，不能证明请求者有管理权限。没有 Token，能访问该端口的其他本机进程就可能修改工作区授权、批准操作或解除设备绑定。因此，不要分享完整链接或公开本地管理端口。

Token 不写入 Runtime 配置，只对当前进程有效。每次启动重新生成，是为了让以前复制、记录或泄露的链接在重启后失效。重启后，旧标签页若用旧 Token 重连会收到 `401`；请打开当前终端打印的新链接，刷新旧标签页不会更新 Token。已保存的设备绑定与工作区授权不受影响。

## Runtime 配对

1. 打开当前 Runtime 启动时打印的完整 [本地管理链接](#本地管理-token)。
2. 在本地 UI 添加或选择官方 Server，地址填写 `https://rcm.aysirui.com`（不带 `/mcp`）。
3. 点击 **生成配对码**，获得临时配对码。
4. 点击“打开平台授权页面”，在 [官方控制台](https://rcmconsole.aysirui.com/) 使用 RCM 账号登录，输入配对码并确认。
5. 返回本地 UI 点击“我已确认，完成绑定”。
6. 在 [官方控制台](https://rcmconsole.aysirui.com/) 确认设备已绑定并在线。

## 添加工作区

1. 在 Runtime 打开「工作区」页面，确认当前连接的是官方 Server。
2. 点击「添加项目」，通过目录浏览器选择本机测试项目。
3. 确认工作区已授权，并在 Console 的工作区管理中查看同步结果。

## 设置权限

首次添加项目默认只读。需要修改文件时，在 Runtime 开启对应工作区写入权限，并分别设置 File / Git / Command 策略为「禁止」「审批执行」或「完全允许」。

Git 暂存、提交和高危递归删除保留强制审批；临时命令也需要单次审批。更多细节见 [工作区权限与数据流向](./workspace-permissions.md)。

## 处理审批

当 AI 工具触发需要审批的操作时，打开 Runtime 的审批页面，核对目标工作区、操作及详情，再选择批准或拒绝。批准不代表放开其他操作权限，待审批请求五分钟后过期。

如果配置了 Console 审批通知渠道，也可以通过机器人卡片处理审批；第一个有效决定生效。参见 [Console 审批通知](./console.md#审批通知渠道)。

## Runtime 审批通知

在 Runtime 页面点击“开启浏览器通知”，允许后新审批会触发系统弹窗；拒绝时可在浏览器站点设置中修改。页面需保持打开并具备有效的本地管理凭据，使用受支持的桌面浏览器和安全来源（回环地址或 HTTPS）。通知仅显示待审批数量，点击后进入审批页，不会自动批准操作。

存在待审批操作时，标签页显示红点和待审批数量，处理完成或请求过期后恢复。支持 Web Locks 的浏览器由一个标签页发送通知，其他标签页更新角标；不支持时通过稳定通知 tag 合并相同审批。页面关闭后不保证继续通知。

## 文件读写

`file_read` 和 `file_write` 使用工作区相对路径。默认的 `encoding: "utf8"` 用于 UTF-8 文本，单文件最多 512 KiB。`file_search` 逐行搜索 UTF-8 文本，单文件最多 256 KiB。

读取图片、PDF、Office 或其他原文件时，用以下参数调用 `file_read`：

```json
{ "workspaceId": "工作区 ID", "path": "public/logo.png", "encoding": "stream" }
```

工具返回 `url`、`method` 和 `expiresAt`。客户端须在 2 分钟内使用同一账号和 OAuth 客户端的 Bearer Token 向该地址发出 GET 请求。响应为原始文件字节。HTTP/1.1 中继可在响应末尾提供 `X-Content-SHA256`，客户端也可自行计算下载文件的摘要。每个地址只能领取一次，断开后重新调用工具获取地址。

写入时调用 `file_write`，指定 `encoding: "stream"` 和原文件准确的字节数 `size`。随后向返回的地址发起 PUT 请求，使用同一 OAuth Bearer Token，并以 `Content-Type: application/octet-stream` 发送原始文件。上传成功会返回写入后的 SHA-256。新建时省略 `expectedSha256`，覆盖时提供当前文件的原始字节 SHA-256。Runtime 在确认权限和审批后才开始消费上传流。

原文件上传和下载上限为 64 MiB。查看不超过 512 KiB 的图片时，可以直接调用 `file_read` 并指定 `encoding: "preview"`。Server 仅在生成 MCP `image` 内容块时进行 Base64 编码。预览显示取决于客户端，原文件模式要求客户端能够另外发起带 OAuth 的 HTTP 请求。

## 命令执行

在项目的更多操作菜单选择 **添加本地命令**，登记命令 ID、显示名称、可执行程序和固定参数。AI 使用 `command_list` 查询可用 ID。`command_run` 的 MCP 参数包含 `workspaceId`，另加以下两种互斥形式之一：

```json
{ "workspaceId": "你的工作区 ID", "command": "build" }
```

```json
{ "workspaceId": "你的工作区 ID", "executable": "pnpm", "args": ["run", "lint"] }
```

第一种形式选择内置或本机登记命令，不能覆盖其固定参数。第二种形式请求临时命令，审批后也不会自动登记。命令执行需要工作区写权限，未知命令 ID 会被拒绝。

| Command 策略           | 内置 / 登记命令 | 临时命令     |
| ---------------------- | --------------- | ------------ |
| `deny`（禁止）         | 拒绝            | 拒绝         |
| `approval`（审批执行） | 本机单次审批    | 本机单次审批 |
| `allow`（完全允许）    | 直接执行        | 本机单次审批 |

审批展示完整程序、参数、工作目录及风险。命令以 Runtime 账号权限执行，没有文件系统、网络或 CPU / 内存隔离；审批不能保证项目脚本和依赖内容不变。Git 操作使用独立工具，不通过 `command_run` 执行。

普通登记命令和临时命令默认执行时限为 60 秒。内置 `build`、`typecheck`、`test` 各 10 分钟，`format` 为 2 分钟。通过 Runtime 本地管理 API 登记自定义命令时可设置 `timeoutMs`（1,000～1,200,000 毫秒），远程请求不能覆盖。执行计时从启动子进程开始，不包含本机审批等待。命令 RPC 最多等待 25 分钟 15 秒；其他工具仍为 5 分钟。

Console 将命令无法启动（`COMMAND_START_FAILED`）、非零退出（`COMMAND_EXIT_NONZERO`）、异常终止（`COMMAND_PROCESS_TERMINATED`）和本机执行超时（`COMMAND_TIMEOUT`）记为失败，与 Server 无响应超时（`EXECUTION_TIMEOUT`）分开。审批拒绝和过期分别显示 `APPROVAL_DENIED`、`APPROVAL_EXPIRED`。对于已经启动但未成功完成的命令，MCP 返回 `isError: true`，文本内容为包含 `code`、`command`、`exitCode`、`output` 和 `truncated` 的 JSON。输出最多 48 KiB，只返回给发起调用的客户端；进程树清理是尽力措施。

### Runtime 终端日志

命令执行日志记录实际的可执行程序、参数数组、绝对工作目录和执行时限。结束时记录退出码、耗时、超时状态及已收集的合并输出（沿用 48 KiB 上限和截断标记）。启动失败也会记录尝试执行的程序和参数；工具请求失败时会在本地 RPC 日志中保留原始入参。上述诊断字段不写入 Server 或 Console 审计；MCP 调用方仍按原工具契约接收命令执行结果。

Runtime 通过项目内的 `logger.debug()`、`logger.info()`、`logger.error()` 统一输出，业务代码不直接依赖 Pino。调试和运行信息写入标准输出，故障写入标准错误。

启动 Runtime 前设置 `RUNTIME_LOG_LEVEL`：`info`（默认）记录启动、连接与 RPC 结果；`debug` 额外记录本地 API 成功请求、授权、审批、执行与重连；`error` 仅输出故障。交互式终端的首行只显示本地时间、级别和事件；已记录的字段（包括 URL、请求参数、状态、耗时）及异常堆栈在下方缩进展示；管道和重定向中的诊断日志仍为逐行 JSON。日志包含适用的请求 ID、执行阶段、错误码和耗时。`requestId` 对应 Server 审计记录的 `operationId`。已捕获的失败只记录业务上下文、错误消息及可用的系统错误码和路径；显式传入原始异常时才附带完整堆栈。本地 API 失败日志（以及 `debug` 下的成功日志）记录原始请求 URL（含查询字符串）、解析后的查询参数和 JSON 请求体，不记录认证请求头或响应正文。管理链接和私密提醒在本地服务监听成功后单独显示，支持颜色的终端会高亮。

默认情况下，未处理的 Promise 拒绝会记录 `runtime.unhandled_rejection` 和堆栈，但不主动退出；未捕获的同步异常和无法完成初始化的启动失败仍会记录 `runtime.fatal` 后以退出码 1 停止，避免继续使用可能不一致的状态。原始异常只在本地输出，不上传 Server；RPC 错误仍使用公开错误码，Server/Console 审计仍只保存脱敏元数据。异常文本和请求参数可能含绝对路径、配对凭据或其他私密信息，分享前请检查；不要分享含本机会话令牌的管理链接。

## Runtime 多服务器配置

Runtime 可以保存多个服务器配置，同一时间连接一个服务器。每台服务器分别保存名称、地址、设备 ID、配对凭据、工作区授权和写入策略。添加后在对应平台配对一次，之后切换、暂停和重启均保留绑定；切回已有服务器不会重新创建设备。相同服务器地址重复添加时会复用原配置。

本地目录与命令定义只登记一次，但服务器不会自动获得已有目录的访问权限。在“工作区”页面，先确认当前服务器，再逐项授权；默认只读，写入权限与审批策略按服务器独立设置。切换服务器会取消尚未完成的审批。

Console 操作记录详情会展示已开始执行的 `command_run` 脱敏命令，例如 `pnpm run build`。Runtime 发送前和服务器入库前均按白名单处理：只保留常见程序名、任务和无值开关，程序目录被移除，未知程序、路径、凭据、脚本正文及其他未识别参数显示为 `[已隐藏]`；遇到未知参数后，其余参数一并隐藏。不保存工作目录、命令输出或 AI 对话。历史记录及旧版 Runtime 没有命令摘要。设备配对时可点击配对码旁的复制图标，在平台填写。

“暂停连接”保留配置；“解除绑定”及移除已绑定服务器会先尝试在服务器撤销设备，再清除本地设备凭据。离线时界面另提供“仅清除本地绑定”，该操作不会在远端撤销设备；如使用此入口，还需前往对应 Console 撤销旧设备。

旧版单服务器配置会自动迁移为配置格式版本 2，保留原来的设备身份、工作区 ID 与权限，迁移前保存 `config.v1.backup.json`。软件版本 `0.2.0` 与配置格式版本 `2` 分别维护。已撤销或失效的设备凭据不会自动重新配对。

## OAuth 客户端授权与刷新令牌

- `/oauth/token` 的授权码兑换和刷新成功均返回 HTTP 200（RFC 6749 §5.1），失败返回对应 OAuth 错误状态；`/oauth/register` 注册成功返回 HTTP 201。令牌端点不能沿用 NestJS POST 默认的 201，部分客户端会将其判为刷新失败。

- OAuth 授权关系保存在 `oauth_grants`，与一小时有效期的 Access Token 独立；Console 的“已授权 AI 客户端”不再因 Access Token 过期而隐藏。
- 授权码 + PKCE 成功兑换后返回 `access_token`（3600 秒）和 `refresh_token`（最长 30 天）；支持 `POST /oauth/token` 使用 `grant_type=refresh_token`、`refresh_token` 换取新的 Access Token 和 Refresh Token。公共客户端刷新时 `client_id` 可省略（RFC 6749 §6）；提供时必须与令牌归属一致。刷新不要求携带 `resource` 或 `scope`，签发结果沿用原授权的资源与权限。
- Refresh Token 服务端只保存 SHA-256 摘要，每次刷新原子消费旧令牌并发放新令牌；再次使用已消费令牌视为重放并撤销同一 Token family。过期、撤销或检测到重放后需要重新进行授权。
- 用户可通过 Console 撤销某客户端授权，服务端同时撤销该客户端已有 Access/Refresh Token。授权数据按用户+客户端隔离。
- 服务端在标准输出记录结构化 OAuth 安全事件（不含 code、token、PKCE、Cookie、CSRF、请求体）；拒绝请求会附带 `request_id` 方便定位。发生在反向代理或 WAF 的拦截需要结合对应日志判断。
- 排查刷新失败时，可使用响应头 `X-Request-Id` 关联服务端日志中的 `requestId`，结合时间定位客户端及代理日志。入口 `token.refresh_received` 记录公开客户端 ID 及参数是否存在，不记录令牌、资源或 Scope 参数内容；被代理、WAF 或请求体解析层提前拒绝的请求不会到达此入口，需查看对应层的日志。
- `token.refresh_rotating` 记录旧 `tokenId`、新 `nextTokenId`、`familyId`、`grantId` 及旧令牌到期/消费时间；这些是数据库记录 ID，不是令牌原文或摘要。只有后续同编号的 `token.refreshed` 才表示事务提交成功；`token.refresh_transaction_failed` 表示轮换执行或提交抛出异常，`reason` 只记录白名单中的死锁、锁等待超时、连接中断等驱动错误码，其余统一为 `database_error`，不记录异常正文。
- `token.refresh_rejected` 的 `reason` 区分 `token_not_found`、`client_mismatch`、`grant_not_found`、`user_not_found`、`user_inactive`、`grant_revoked`、`grant_client_mismatch`、`resource_mismatch`、`token_expired` 和 `token_revoked`。`token.refresh_replay_detected` 表示发现已消费令牌；后续同编号的 `token.refresh_replay` 表示撤销事务已提交。
- `token.refresh_response_finished`、`token.refresh_response_closed`、`token.refresh_response_error` 分别表示响应完成写出、完成前连接关闭和响应流错误，附 HTTP 状态、耗时（毫秒）、响应头是否发出及流是否写完。`finished` 仅证明本机 HTTP 层完成写出，不能证明代理已转发或客户端已保存新令牌。若先出现 `token.refreshed`，随后同一 `tokenId` 被重放，需结合这些事件和代理日志区分响应中断、并发刷新与客户端保存失败。
- **无感刷新由客户端发起**：RCM 提供标准 Refresh Token 协议，具备自动刷新实现的 MCP 客户端可自行续期。切换客户端或版本时，请在目标环境验证自动续期行为。
- OAuth 授权验证：授权码兑换得到两种 Token；过期 Access Token 返回 401；刷新成功后新 Access Token 可使用；旧 Refresh Token 再次使用被拒绝；Console 撤销后 Access/Refresh Token 均被拒绝；重复并发刷新不可同时成功。

## 审批通知渠道

飞书、企业微信和钉钉通知渠道的绑定及远程审批操作见 [Console 审批通知](./console.md#审批通知渠道)。

## MCP 接入验证

将官方 MCP Server 地址 `https://rcm.aysirui.com/mcp` 配置到支持 OAuth 的 MCP 客户端，并使用同一平台账号授权。按 [AI 工具接入指南](./connect-clients.md) 完成首次只读调用。遇到连接问题时，可用 MCP Inspector 检查元数据、授权与工具调用；不保证所有客户端版本都能自动刷新令牌。

- `GET /health` 应返回 `{ok:true}`。
- `GET /.well-known/oauth-protected-resource` 和 `GET /.well-known/oauth-authorization-server` 应返回元数据。
- 无 Token 请求 `/mcp` 应返回 401 和 `WWW-Authenticate`。
- 完成 DCR → Authorization Code + PKCE → Token，使用 Bearer Token 调用 `device_list`、`workspace_list`、`file_read` 和 `git_status`。

工具返回文本及 `structuredContent`，并声明输出 Schema；输入输出字段以 [共享协议](https://github.com/aysirui/remote-code-mcp/blob/main/packages/protocol/src/mcp-tools.ts) 为准。
