# 代码结构与中文注释约定

当前 Monorepo 将共享契约、云端 Gateway、前端 Console 与本地 Runtime 分开维护。

## packages/protocol（跨进程共享契约）

| 文件             | 职责                                             |
| ---------------- | ------------------------------------------------ |
| `operations.ts`  | 工具名称白名单、写操作判定                       |
| `workspace.ts`   | 工作区授权公开模型（不包含本地目录）             |
| `rpc.ts`         | Gateway 与 Runtime 之间的请求、响应及 Hello 协议 |
| `tool-inputs.ts` | 各工具 Zod 入参校验                              |
| `index.ts`       | 包对外统一导出                                   |

## apps/server（云端 Gateway）

| 文件                         | 职责                                          |
| ---------------------------- | --------------------------------------------- |
| `main.ts`                    | NestJS 模块注册、HTTP 初始化和 WebSocket 挂载 |
| `schema.ts`                  | Drizzle 业务表模型                            |
| `store.ts`                   | 数据库基础访问和审计                          |
| `identity.ts`                | 用户、Session、密码及管理员权限               |
| `security.ts`                | 随机 ID、令牌及哈希工具                       |
| `device-hub.ts`              | 设备 WSS 认证、连接状态、RPC 路由与授权       |
| `http-security.ts`           | Cookie、Origin、CSRF 的浏览器安全边界         |
| `auth.controller.ts`         | 登录、注册、改密及会话 HTTP API               |
| `account.controller.ts`      | 个人设备、工作区、授权和审计 HTTP API         |
| `admin.controller.ts`        | 管理员用户/设备/审计 HTTP API                 |
| `pairing.controller.ts`      | 设备一次性配对 HTTP API                       |
| `oauth-service.ts`           | OAuth Token 与 Client 校验                    |
| `oauth-utils.ts`             | OAuth 参数签名与辅助安全校验                  |
| `oauth.ts`                   | OAuth 授权 HTTP API                           |
| `mcp.ts`                     | MCP Streamable HTTP 服务与工具注册            |
| `core.ts` / `controllers.ts` | 不含业务实现的公共导出入口                    |

## apps/runtime（本地设备）

| 文件                 | 职责                                  |
| -------------------- | ------------------------------------- |
| `main.ts`            | Runtime 连接生命周期及进程启动        |
| `state.ts`           | 本地私有配置及工作区公开信息          |
| `gateway-client.ts`  | Axios 云端配对 HTTP 客户端            |
| `local-server.ts`    | 仅监听 loopback 的本地管理 API        |
| `write-approvals.ts` | 本地逐次写入审批队列与取消逻辑        |
| `executors.ts`       | 请求级权限校验和工具分发              |
| `path-safety.ts`     | 路径遍历、敏感文件及软链接检查        |
| `file-operations.ts` | 受控文件读取、Hash 冲突校验和原子写入 |
| `git-operations.ts`  | 受控 Git 状态及 Diff 查询             |

## Vue 前端

- Console：`App.vue` 保留模板；`use-console.ts` 管理页面状态与业务动作；`api.ts` 封装 Axios、Session Cookie 与 CSRF。
- Runtime 本地页面：`App.vue` 保留模板；`use-runtime-console.ts` 管理页面状态；`http.ts` 封装仅访问同源本地 API 的 Axios 与 Bearer Token。

## 编码原则

1. **关键方法需说明意图**：中文 JSDoc 描述输入、授权边界、副作用以及失败后的行为，不重复每一行的语法。
2. **类型需说明语义**：特别是是否含敏感字段、是否允许远程传输以及字段代表的权限来源。
3. **单一职责**：Controller 负责 HTTP 入参/响应，Service 负责业务规则；Runtime 路由只负责本地 API，文件/Git 工具各自校验输入。
4. **共享协议不依赖具体业务实现**：`@rcm/protocol` 只能包含契约，不引用 NestJS、Vue、Node 文件系统。
5. **Axios 管理 HTTP**：浏览器统一通过 Console/Runtime 的 HTTP 模块请求；WSS 保持原生 WebSocket 协议。
6. **安全校验不得因拆文件失效**：工作区授权、CSRF、OAuth、设备认证、路径安全及文件写入审批仍在各自的边界执行。

目前本地文件插件不支持新建目录，所以上述模块首先按职责独立成同级文件；未来可不改变设计地移动到 `auth/`、`device/`、`workspace/`、`http/` 等子目录。迁移时应一次性更新相对 import 并运行构建测试，不要同时维护两套实现。
