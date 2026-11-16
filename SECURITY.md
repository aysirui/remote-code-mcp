# Remote Code MCP security and deployment checklist

> Security hardening is in progress. Do not expose this service to untrusted tenants until the test and operational controls below have been verified.

## Authentication and administrator initialization

- User passwords are bcrypt-hashed (cost 12); passwords must be 12–72 UTF-8 bytes.
- `ADMIN_EMAIL` is reserved and **never** elevated through public registration. The Docker Compose entrypoint automatically initializes the first administrator after applying DB migrations; `pnpm admin:init` remains available for local development.
- The initializer takes an advisory MySQL lock, checks existing administrators and email conflicts, and prints a random temporary password **once** to the first deployment log.
- For the internal development deployment, the initial credential is intentionally printed in Dokploy logs. Restrict deployment-log access and retention, avoid third-party log forwarding, and rotate the password at first login. Already captured logs are not automatically erased by password rotation.
- Administrators initialized by the command have `password_change_required=true`. Until changed, normal authenticated API routes reject access. The Console provides a forced password-change form; all sessions are revoked once the password is changed.
- Production must enforce HTTPS at the reverse proxy. Secure CSRF, cookie and CORS behavior depends on correct `PUBLIC_URL` / `CONSOLE_URL` values.

## Dokploy deployments and migration discipline

- Drizzle migration SQL, snapshots and `meta/_journal.json` are generated **locally**, reviewed and committed to Git together with `apps/server/src/infrastructure/database/schema.ts`.
- The Server image includes committed `apps/server/drizzle/` files. On deployment, the entrypoint fails closed if the migration journal is absent, then runs `drizzle-kit migrate`, initializes the first administrator if necessary, and starts NestJS only after those steps succeed.
- **Never run `drizzle-kit generate` inside the deployment container.** There is no `drizzle_history` persistent volume; only MySQL data is persisted. Drizzle records applied migrations in the database.
- Run one migration executor at a time. This entrypoint is intended for a single Server instance; scale-out deployments need a dedicated migration job before starting application replicas.
- The first successful deployment prints initial admin credentials in Server logs; no bootstrap file or volume is used. Subsequent deployments do not print credentials or reset the administrator password.
- Restrict access to these logs and rotate the initial password at first login.

## Local Runtime and filesystem boundaries

### 本次安全加固与兼容性变化

- 本地管理路由统一校验 Bearer Token；URL 大小写变化不能跳过鉴权，Host/Origin 校验仍然生效。
- 所有 Git 工具拒绝有效配置中的外部 filter（包括 include 配置），Git 子进程只继承白名单环境变量。使用 Git LFS 等 filter 的仓库将被拒绝，不能退回不受保护的执行路径。
- 文件读取、搜索、写入、移动、删除和 Git 暂存拒绝多重硬链接；Git diff 也校验候选工作树路径。二进制 Git 暂存仍保留原始字节。
- `.remote-code-mcp` 及内部子目录禁止远程访问；自定义 `RUNTIME_DATA_DIR` 按配置路径和真实路径同时保护，包括配置备份。禁止将数据目录作为工作区。
- `command.run` 默认通过本机进程后端执行，不要求隔离环境。内置/登记命令受本地 Command 策略控制；临时程序及参数在 approval/allow 下必须单次本机审批，deny 下直接拒绝。审批展示完整程序、参数、工作目录与风险，指纹绑定执行内容，批准后不会自动登记。命令具备 Runtime 账号权限，可访问项目外文件、网络和凭据；没有 CPU/内存硬限制。超时及进程树清理属于尽力措施。
- 有界读取及读取后复核缩小了文件增长和路径替换的影响，但不能消除原生文件系统接口缺失造成的父目录替换竞态。部署时仍须用专用系统账号、ACL 或容器限制 Runtime 的操作系统权限；不得声称应用层路径检查构成完整沙箱。
- 生产依赖已升级至安全公告修复范围，`pnpm-lock.yaml` 固定完整依赖树；CI/部署使用 `pnpm install --frozen-lockfile`。

- Run Runtime as an ordinary, dedicated OS account with access only to intended workspace directories. Never run it as root or an administrator. Node.js path checks are **not a substitute for OS-level sandboxing**.
- The runtime rejects absolute paths, `..`, symlinks visible during validation, hardlinks, common secret files, and policy-denied writes. Existing file replacements require the current SHA-256, and write via a same-directory temporary file and rename.
- Race conditions against **parent directory replacement** cannot be fully eliminated using portable Node.js `realpath` and `O_NOFOLLOW`; use OS-level containment (container, sandbox, ACL, mount namespaces, dedicated account), and test on each supported OS.
- Never authorize a workspace root containing credentials, private keys, production data, the user's entire home folder, or other broad filesystem trees.
- The local management API is loopback-only and requires an in-memory Bearer token. Do not reverse-proxy its port or expose its token.
- Local configuration includes a device credential. Protect it with filesystem ACLs/permissions; Windows secure-store integration remains a further hardening item.

## OAuth and device security

- OAuth uses authorization code + PKCE S256. Consent parameters are bound with an APP_SECRET HMAC, and code redemption uses a database transaction/row lock.
- Device pairing approval and token retrieval use database transactions/row locks to guard state transitions.
- Only HTTPS remote gateways are accepted for device connectivity. Loopback HTTP is supported for local development.
- The supplied OAuth implementation is custom code. **Full interoperability and adversarial OAuth testing are still required before claiming standards compliance**. Refresh tokens use rotation and replay revocation.
- Administrators should disable compromised accounts and revoke devices and OAuth grants promptly.

## Validation before deployment

From the repository root:

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm check
docker compose build
```

Additionally verify:

1. User A cannot operate User B's workspace ID or device ID.
2. 本地停用的工作区在重连后仍保持停用，云端只展示 Runtime 同步的权限与策略。
3. A revoked device's old WebSocket cannot send a valid response for a new connection.
4. Simultaneous OAuth code redemption succeeds only once.
5. Simultaneous pairing approvals and completion each succeed only once.
6. Missing/invalid CSRF tokens and unrelated Origin/Host headers are denied.
7. Traversal, links, sensitive files and stale SHA-256 writes are denied.
8. Git diff/status cannot expose secret contents or run externally configured commands.
9. The service fails safely if the database or secure upstream is unavailable.

## Known remaining work

- Cross-platform adversarial filesystem race testing and OS-level sandboxing.
- 工作区权限和工具策略由 Runtime 本地统一管理，云端只保存同步快照。审批请求五分钟后过期；高危递归删除和 Git 写操作仍需本机强制审批。
- Verified email ownership, account recovery, multi-factor authentication, durable distributed rate limiting and abuse monitoring.
- Dedicated OAuth conformance testing, key rotation, and token/authorization-record retention cleanup.
- End-to-end test run and production deployment review: these cannot be established by source inspection alone.
