# 贡献指南

欢迎反馈问题、修正文档和提交代码改进。开始前请阅读 [README](README.md)、[安全说明](SECURITY.md) 和 [项目协作规范](AGENTS.md)。

## 问题反馈

普通问题请通过 GitHub Issue 描述使用场景、复现步骤、预期与实际结果，并附操作系统、Node.js / pnpm 版本及提交号。日志和截图需脱敏，不要上传 `.env`、设备凭据、访问令牌、本地绝对路径或私有源码。安全漏洞请遵循 [私下报告流程](SECURITY.md#报告安全问题)。

较大的功能或行为变化建议先开 Issue 说明需求及权限影响，避免重复工作。

## 本地开发

按 [快速开始](README.md#快速开始) 安装依赖并配置独立开发数据库。不要使用生产数据库进行开发或测试。

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

优先运行受影响模块的检查，例如 `pnpm --filter @rcm/runtime test`。`pnpm check` 包含 lint、类型检查和格式检查，不包含测试与构建。

跨平台文本统一使用 UTF-8 和 LF。可对本次修改文件执行 `pnpm exec prettier --write <文件路径>`，避免无关的全仓库格式变动。

## 修改约定

- 保持业务逻辑就近组织，避免与需求无关的抽象、重命名及重构；模块职责以 `AGENTS.md` 为准。
- 关键逻辑、函数及字段使用准确的中文说明，行为变化时同步维护注释和文档。
- 修改 RPC 契约时同步更新 `packages/protocol` 和 Server / Runtime 使用方；不得削弱身份、授权、路径安全或资源清理边界。
- 数据库结构先修改 `apps/server/src/infrastructure/database/schema.ts`，再手动运行 `pnpm db:generate`，检查生成的 SQL、快照及 `meta/_journal.json`，一并提交。不要手写或直接修改迁移产物。
- 测试验证实际业务行为、权限边界或回归问题，不为目录布局、命名及代码风格新增架构测试。

## Pull Request

说明解决的问题、最终行为、验证命令及实际退出状态，标明未验证事项。涉及权限、协议或数据迁移时，说明影响和必要的部署步骤。请保持改动范围集中，不提交依赖目录、构建产物、测试数据或个人环境配置。

提交贡献即表示你有权提供这些内容，并同意按本项目的 [AGPL-3.0-only](LICENSE) 许可证分发你的贡献。第三方代码或素材需保留原有许可与来源声明。

除另有有效约定外，外部贡献的版权仍归其原权利人，不因合入仓库自动转让给安阳市思锐科技有限责任公司。本贡献约定不额外授予公司以其他许可证再许可外部贡献的权利。具体许可边界见 [许可证说明](docs/licensing.md)。
