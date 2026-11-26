# AGENTS.md — Remote Code MCP 项目协作规范

本文件适用于整个仓库。开发者及 AI 编码助手修改代码前应阅读本文件；以当前源码和实际业务需求为准，文档不能替代代码验证。

## 一、项目定位与架构

Remote Code MCP（RCM）是基于 pnpm workspace 的 TypeScript monorepo。其目标是在用户授权下，让 ChatGPT 等 MCP 客户端通过远程 Server 安全调用用户本地工作区的文件、Git 和已登记命令。当前采用 **Server + Console + Website + Docs + Runtime + Protocol** 六部分，而非通用 OS 沙箱平台。

主要调用链：

```text
MCP 客户端（ChatGPT 等）
    │ HTTPS / MCP Streamable HTTP / OAuth 2.0
    ▼
apps/server（NestJS Server） ── MySQL（Drizzle）
    │ WSS / 设备身份认证 / RPC
    ▼
apps/runtime（本机 Node.js 服务）
    ├── 本地管理 API + Vue Web UI（127.0.0.1）
    └── 已授权 Workspace → File / Git / Command

apps/console（Vue Web 管理台） ── HTTPS ──► apps/server
packages/protocol（共享 RPC、Zod Schema、类型契约）
```

### 目录与职责

- `apps/server/src/app.module.ts`：NestJS 根模块装配；`main.ts` 为入口，`config/env.ts` 统一读取配置。
- `apps/server/src/modules/`：按业务领域组织 `auth`、`account`、`admin`、`core`、`device`、`oauth`、`mcp`。Controller 处理协议入口，Service/Repository 负责对应业务与持久化；相关领域逻辑留在本模块。
- `apps/server/src/modules/device/`：设备配对、WebSocket 连接、工作区同步、RPC 路由、超时和操作审计；`DeviceHub` 由 NestJS 生命周期管理。
- `apps/server/src/modules/mcp/`：MCP HTTP 接口、工具注册和工具到设备 RPC 的映射；服务端验证 OAuth 身份及工作区归属。
- `apps/server/src/infrastructure/database/`：Drizzle Schema、数据库连接、Store；迁移产物位于 `apps/server/drizzle/`。
- `apps/website/`：Astro 独立静态官网，负责公开产品展示、文档、控制台和代码仓库导航；不承载后端业务。
- `docs/`：VitePress 独立文档产物，公共访问前缀为 `/docs/`。
- `apps/console/src/`：Vue 3 + Vue Router + Pinia + Element Plus；页面在 `views/`，页面复用组件在 `components/`，界面业务状态在 `composables/`，API 请求在 `api/`。
- `apps/runtime/src/connection/`：Server WebSocket 连接与重连；`workspace/`：本机目录定义、服务器配置、工作区授权及策略。
- `apps/runtime/src/requests/`：RPC 请求分发、审批策略、审批队列与资源核验。
- `apps/runtime/src/operations/`：文件、Git、Command 领域执行器；Git 操作独立于 `command.run`。
- `apps/runtime/src/local/`：只监听回环地址的本地管理服务及设备配对、工作区和审批 API。
- `apps/runtime/web/src/`：Runtime 内置 Vue 管理界面。
- `packages/protocol/src/`：Server 与 Runtime 共享的操作定义、RPC 契约、Zod 校验和脱敏审计数据结构。不得放入某个应用独有的业务实现。

### 核心实现与业务边界

1. **身份与授权**：MCP 客户端经 OAuth 2.0 授权访问 Server；Runtime 以设备凭据建立 WSS 出站连接。Server 校验用户、设备及工作区归属；Runtime 再按本机工作区授权、读写权限及 File/Git/Command 策略执行。
2. **本地数据隐私**：工作区绝对路径、文件内容、命令参数、审批详情和 AI 对话不作为 Server/Console 的持久化业务数据。Server 仅转发必要的 RPC 数据；操作审计只记录允许的脱敏元数据。
3. **多服务器与工作区**：Runtime 可保存多个 Server 配置，同一时刻连接一个 Server；本地目录定义与各 Server 的工作区授权分离。设备或授权撤销必须使后续请求失效。
4. **文件操作**：在授权工作区内执行读写、搜索、移动、删除；写入版本检查使用 SHA-256，危险删除遵循既定审批规则。
5. **Git 操作**：使用独立的 Git 工具及对应权限策略，不通过临时 Shell 命令绕过。
6. **命令执行**：`command.run` 接受本机登记命令 ID 或临时程序/参数；登记命令遵循本机策略，未登记命令必须审批。命令以 Runtime 进程账号权限运行，不宣称具有 OS 沙箱隔离。默认超时 60 秒；内置构建、测试、类型检查各 10 分钟，本地自定义登记命令最长 20 分钟，远程请求不能自行提高超时。
7. **数据库**：Server 使用 Drizzle ORM 与 MySQL；Schema 是数据库结构变更的来源。部署执行已提交的迁移，不在部署环境自动生成迁移文件。

## 二、强制开发约束

### 1. 禁止无意义的防御性编程

- 只处理真实业务要求、可合理发生的失败场景及明确的安全边界，不为不现实、基本不可能触发的假设增加大量校验、兜底、重试、兼容分支或包装层。
- 不使用宽泛 `try/catch` 隐藏错误，不为了“保险”重复校验已经由明确契约保证的内部数据。
- **本条不允许移除必要的身份认证、授权、输入校验、并发一致性、路径安全和资源清理**；这些属于产品真实安全要求。新增防护应说明具体风险及触发条件。

### 2. 数据库迁移必须由工具生成

- 修改数据库字段、索引、约束或表结构时，先修改 `apps/server/src/infrastructure/database/schema.ts` 中的 Drizzle Schema。
- **必须手动执行 `pnpm db:generate`**，检查工具生成的 SQL、快照及 `meta/_journal.json`，并将生成结果与 Schema 一起纳入变更。
- **严禁手写、复制拼接或直接修改迁移 SQL 和 Drizzle 元数据来代替生成**。如生成结果不符合预期，应调整 Schema 并重新生成，必要时说明人工介入原因。
- `db:generate` 与 `db:migrate` 是不同操作：前者生成迁移，后者连接目标数据库执行迁移；未经明确授权不得擅自运行生产数据库迁移。

### 3. 禁止随意抽象和提取公共方法

- 默认保持业务逻辑直接、清晰、就近实现，不为缩短文件、减少几行重复代码、预想未来扩展而引入公共函数、基类、适配器、工具包或新层级。
- **只有属于项目基础工具、且在相关适用场景中复用率达到 50% 以上时，才考虑抽象为公共能力**；抽象前应说明复用范围及收益。
- 领域专用的内部函数可以留在其业务模块内，但不得仅为了“架构更整齐”跨模块抽取。
- 不开展与当前需求无关的大规模重命名、拆文件或重构。

### 4. 模块内聚，相关逻辑就近组织

- 按业务领域组织文件；Controller、Service、Repository、校验及内部辅助逻辑应尽量与所属模块相邻。所有测试文件必须放在所属应用或包的 test 目录下，不得与源代码混放。
- 不把模块私有业务逻辑放入全局 `utils`、`common`、`shared` 或其他无业务归属的目录。
- 只有确实跨领域使用的底层契约才放到 `packages/protocol`；数据库基础设施保留在 Server 的 infrastructure。
- 新增文件之前先检查现有模块是否已有适当位置；优先修改现有实现，避免形成零散小文件。

### 5. 只新增与业务相关的代码和测试

- 新增或修改代码必须直接服务于业务需求、明确的缺陷修复或必要的安全与稳定性。
- 测试应验证真实业务行为、权限边界、失败恢复和已发生的回归问题；**不新增专门检查目录布局、分层规则、循环依赖或编码风格的架构测试/脚本**。
- 架构原则、依赖约束、命名规范、设计权衡写入本文件或业务文档，不以运行时代码或额外校验脚本表达。
- 不为了让测试通过而改变原有业务语义，也不为不现实的边界条件扩充测试矩阵。

### 6. 中文描述必须完整并与实现同步

- 无论新增还是编辑代码，所有涉及的关键逻辑、关键代码、函数定义和字段定义都必须提供准确的中文描述；编辑已有代码时，缺失的描述必须一并补齐。
- 关键逻辑和代码使用就近的中文注释说明业务目的、处理规则及必要的权限或安全边界；函数定义说明用途、参数与返回值的业务含义，字段定义说明含义及必要的取值约束、单位或默认行为。
- MCP 工具的 `description`、输入与输出 Schema 的 `.describe()` 以及接口、类型和配置中的字段说明均使用中文；工具名、字段名、代码标识符和协议约定值保留原有命名。
- **逻辑、函数行为或字段语义发生变动时，必须在同一次修改中同步更新对应注释、描述信息及相关文档**，不得保留与实际实现不一致的说明，也不得通过删除必要描述来规避维护。

## 三、修改与验收流程

1. 先阅读目标模块现有代码、调用方和相关测试，明确问题及业务影响；避免凭猜测修改。
2. 采用最小且完整的业务改动，保留原有行为和权限边界；按第二节第六条补齐本次涉及的关键逻辑、关键代码、函数定义和字段定义的中文描述，并同步更新因逻辑变动而过期的说明。
3. 涉及协议变化时同步更新 `packages/protocol` 及 Server/Runtime 的实际使用方；涉及数据库结构变化严格执行第二条。
4. 只增加能够验证此次业务改动的测试。优先运行相关模块测试，再按需要执行全项目检查。
5. 常用命令：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`；数据库生成：`pnpm db:generate`。
6. 交付时报告实际修改文件、验证命令、退出状态及未验证事项。不得把命令超时或仅看到各模块日志完成描述成全项目退出码为 0。
7. 未经用户明确要求，不执行 Git Commit、Push、部署、生产数据库迁移或清理用户已有修改。

## 四、文档优先原则

架构说明和开发约束以本文件为主要入口；业务使用、部署、环境变量和操作流程继续放在 `README.md` 等相应文档。架构约束不应额外演变为侵入项目的运行时逻辑、自动审计程序或无业务价值的测试。

## 五、版本发布规范

- 遵循 CONTRIBUTING.md 的分支与版本发布流程，提交采用 Conventional Commits，scope 可选。
- Release Please 统一维护产品版本、各模块版本、CHANGELOG、Tag 和 GitHub Release；未经明确授权不得合并发布 PR、手动打 Tag 或发布版本。
- 涉及协议、数据库迁移、权限或配置不兼容变化时，在提交及发布说明中明确升级影响。
