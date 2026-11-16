# Command OS 级沙箱设计

## 目标与安全边界

Command 工具只接受 Runtime 本机登记的命令 ID，远程请求不得提供 executable、args、cwd 或环境变量。逐次审批用于授权某一次操作，不代表操作系统隔离。

沙箱必须在启动目标程序之前建立，并覆盖目标进程及其全部后代进程。沙箱能力不足、运行环境不支持、初始化失败或无法确认策略已生效时，必须失败关闭，不得退回当前的普通 spawn。

## 统一接口

Runtime 通过 `SandboxProvider` 适配不同操作系统。业务层只传递已解析的本地命令和明确的资源策略，不直接拼接平台命令行。

建议接口语义：

- `probe()`：检测平台、内核/API 版本、所需权限和后端可用性；返回结构化能力，不执行用户命令。
- `run(request)`：在隔离环境中启动固定 executable 与 args，并返回受限的 stdout/stderr、退出码和超时状态。
- `terminate(runId)`：终止该次运行的整个受控进程组。
- `dispose()`：释放 Job、fd、临时策略文件等资源。
- `SandboxRunRequest` 仅包含 executable、args、cwd、最小环境变量、只读/读写目录白名单、网络策略、资源上限和超时；这些字段只由 Runtime 内部构造，不能直接从 MCP 入参映射。

Provider 返回的能力必须区分“进程树管理”“文件系统隔离”“网络隔离”“资源限制”，不能只用一个 `supported` 布尔值误导调用方。

## 平台评估

### Windows

- Job Object 可将进程及其后代作为整体管理，支持终止整个 Job、进程数/内存/CPU 等资源限制；必须禁止 breakaway，并使用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。
- Job Object 本身不是文件系统或网络访问控制，不能单独作为完整沙箱。
- 完整隔离还需要受限 Token、低完整性级别或 AppContainer，并通过 ACL / capability SID 控制可访问目录和网络能力。
- 创建进程时应先以 suspended 状态创建、加入 Job 并配置限制，再恢复执行，避免子进程在加入 Job 前逃逸。
- Node.js `child_process` 没有完整 Job Object API；应采用审计过的原生 helper/N-API 模块或独立 helper 可执行文件。不得依赖未经审计、刚发布或缺乏维护证据的 npm 包。
- 如果只能建立 Job Object 而未建立文件/网络限制，能力等级只能标记为 process-containment，不满足本项目完整沙箱策略。

### Linux

- Landlock 可由非特权进程自我施加文件系统访问限制，策略可继承到后续子进程；必须先探测内核 ABI 和实际可用权限，再构建规则。
- Landlock 规则应采用默认拒绝，只开放工作区所需读写目录、运行时必要的系统库/工具目录及明确的临时目录。注意执行程序和动态库的只读访问也需要规则。
- 网络隔离需单独处理：结合受限网络 namespace 或支持的 Landlock 网络权限；不能因为文件系统 Landlock 生效就宣称网络已隔离。
- seccomp 用于缩小 syscall 攻击面，不应单独充当文件访问控制。
- cgroups v2 可用于 CPU、内存、进程数等资源上限，但部署环境可能没有委派权限。
- bwrap/nsjail 等外部工具必须作为固定 helper 使用，固定参数模板、校验版本和能力；不能将其当作任意 shell 命令调用。容器、rootless、Docker 部署环境中还需检测 namespace、LSM、seccomp 和 cgroup 能力。
- 不支持 Landlock/所需 namespace/网络策略时，完整沙箱探测失败，默认拒绝 Command。

### macOS

- `sandbox-exec` / Seatbelt 仍可作为兼容后端评估，但 Apple 文档已将 sandbox-exec 标记为 deprecated，不能将其视为长期稳定的官方接口。
- App Sandbox 需要签名与 entitlement，主要面向应用分发场景；对普通 CLI 子进程并非直接可用的通用替代方案。
- 因此 macOS 后端应标记为 deprecated-compatibility，提供显式启用开关、版本探测和回归测试；不能静默启用，也不能把它作为长期唯一方案。
- 如果未来系统移除该入口或策略加载失败，必须失败关闭。当前没有可确认的通用、非特权、受支持的 CLI 沙箱替代 API。

## 统一安全策略

1. 工作目录固定为授权工作区真实路径；拒绝符号链接绕过和工作区外路径。
2. 默认文件系统只读；仅授权工作区和专用临时目录可写。不得开放用户主目录、SSH、云凭据、Runtime 配置目录、浏览器配置、系统凭据库。
3. 默认禁用网络。若特定本地命令确实需要网络，必须由管理员在本机配置中显式登记网络能力；当前协议不向远程开放该配置。
4. 环境变量采用白名单，不能继承代理凭据、云凭据、访问令牌或完整父进程环境。
5. 限制运行时长、CPU、内存、进程数、输出字节数和临时磁盘空间。
6. 所有子进程必须留在受控 Job/cgroup/namespace 中；关闭 Runtime、取消任务或超时时，清理整个运行组。
7. 沙箱启动失败、能力探测失败、策略不完整、helper 校验失败一律拒绝执行。
8. 操作日志只保留元数据；命令参数、输出和路径仍不上传、不持久化。

## 分阶段落地

1. 先定义 `SandboxProvider`、能力模型和 `SandboxRunRequest`，将当前 spawn 逻辑收敛到 provider 边界。
2. 默认 Provider 使用 fail-closed 实现；未注册完整隔离后端的平台返回 `COMMAND_SANDBOX_UNAVAILABLE`。
3. 优先实现 Linux Landlock + namespace/network + cgroups 的组合后端，提供 helper 自检和安全回归测试。
4. Windows 单独实现原生 helper：Job Object 负责进程树和资源控制，AppContainer/受限 Token 负责资源访问边界。
5. macOS 先提供显式 opt-in 的 deprecated Seatbelt 兼容后端，并持续跟踪 Apple 支持状态。
6. 每个后端必须有攻击性测试：读取工作区外文件、写入工作区外文件、访问凭据目录、访问网络、创建脱离子进程、超时残留、资源耗尽、软链接/硬链接绕过和 helper 被替换。

## 当前实现状态

当前默认 Provider 拒绝执行；普通 `spawn` 只保留为内部进程管理实现。`command.run` 在参数预检和实际执行入口均检查隔离能力；当前尚无文件系统隔离、网络隔离或可靠的资源控制，因此远程调用一律返回 `COMMAND_ISOLATION_REQUIRED`，不会启动目标程序或进入审批队列。仅在经过验证的完整隔离 Provider 接入后才能恢复此能力，不提供不安全回退开关。
