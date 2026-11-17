# 使用指南

先按 [README](../README.md#快速开始) 启动 Gateway、Console 和 Runtime。

## Runtime 配置

Runtime 默认保存配置到 `~/.remote-code-mcp/config.json`。可通过进程环境变量指定 `RUNTIME_DATA_DIR`（私有数据目录）、`RUNTIME_PORT`（默认 18787）及首次配置的 `GATEWAY_URL`（默认 `http://localhost:3000`）。Runtime 不自动读取 `.env`，需在启动进程前设置这些变量；已有服务器配置通过本地 UI 管理。

## Runtime 审批通知

在 Runtime 页面点击“开启浏览器通知”，允许后新审批会触发系统弹窗；拒绝时可在浏览器站点设置中修改。页面需保持打开并具备有效的本地管理凭据，使用受支持的桌面浏览器和安全来源（回环地址或 HTTPS）。通知仅显示待审批数量，点击后进入审批页，不会自动批准操作。

存在待审批操作时，标签页显示红点和待审批数量，处理完成或请求过期后恢复。支持 Web Locks 的浏览器由一个标签页发送通知，其他标签页更新角标；不支持时通过稳定通知 tag 合并相同审批。页面关闭后不保证继续通知。

## Runtime 配对

1. 打开启动日志打印的本地 UI URL，例如 `http://127.0.0.1:18787/#token=...`，**不要分享其中的 token**。
   本地管理凭据每次启动都会重新生成。若页面提示凭据失效，请重新打开当前启动日志中的完整链接；找不到链接时，请重启 Runtime 并打开新打印的链接。刷新旧页面无法恢复，设备绑定和工作区授权不受影响。
2. 在本地 UI 确定 Gateway URL（本机可用 `http://localhost:3000`；公网必须 `https://...`）。
3. 点击 **生成配对码**，获得临时配对码。
4. 点击“打开平台授权页面”（本地开发为 `http://localhost:5173/activate`），用平台账号登录，输入配对码并确认。
5. 返回本地 UI 点击“我已确认，完成绑定”。
6. 点击 **添加项目**，使用目录浏览器选择一个临时测试项目。默认只读；需要修改文件时先开启写入权限，再按 File / Git / Command 分别选择“禁止”“审批执行”或“完全允许”。待审批请求五分钟后过期；Git 暂存、提交和高危递归删除保留强制审批。
7. Web Console 会显示绑定设备和同步工作区。

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

普通命令默认超时 20 秒。内置 `typecheck`、`format` 为 120 秒，`test`、`build` 为 180 秒；本地登记项可配置 `timeoutMs`（1～240 秒），远程请求不能提高超时。输出最多 48 KiB，超时后的进程树清理属于尽力措施。

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
- **无感刷新由客户端发起**：RCM 提供标准 Refresh Token 协议，具备自动刷新实现的 MCP 客户端可自行续期；不能保证所有 ChatGPT 客户端版本都自动使用 Refresh Token，需做实际兼容验证。
- 部署后验证：授权码兑换得到两种 Token；过期 Access Token 返回 401；刷新成功后新 Access Token 可使用；旧 Refresh Token 再次使用被拒绝；Console 撤销后 Access/Refresh Token 均被拒绝；重复并发刷新不可同时成功。

## MCP 接入验证

将公网 Gateway 的 `https://你的服务器域名/mcp` 配置到支持 OAuth 的 MCP 客户端，并使用同一平台账号授权。先用 MCP Inspector 检查元数据、授权与工具调用，再验证目标客户端；不保证所有客户端版本都能自动刷新令牌。

- `GET /health` 应返回 `{ok:true}`。
- `GET /.well-known/oauth-protected-resource` 和 `GET /.well-known/oauth-authorization-server` 应返回元数据。
- 无 Token 请求 `/mcp` 应返回 401 和 `WWW-Authenticate`。
- 完成 DCR → Authorization Code + PKCE → Token，使用 Bearer Token 调用 `device_list`、`workspace_list`、`file_read` 和 `git_status`。

工具返回文本及 `structuredContent`，并声明输出 Schema；输入输出字段以 [共享协议](../packages/protocol/src/mcp-tools.ts) 为准。
