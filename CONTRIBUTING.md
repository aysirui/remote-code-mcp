# 贡献指南

欢迎反馈问题、修正文档和提交代码改进。开始前请阅读 [README](README.md)、[安全说明](SECURITY.md) 和 [项目协作规范](AGENTS.md)。

## 问题反馈

普通问题请通过 GitHub Issue 描述使用场景、复现步骤、预期与实际结果，并附操作系统、Node.js / pnpm 版本及提交号。日志和截图需脱敏，不要上传 `.env`、设备凭据、访问令牌、本地绝对路径或私有源码。安全漏洞请遵循 [私下报告流程](SECURITY.md#报告安全问题)。

较大的功能或行为变化建议先开 Issue 说明需求及权限影响，避免重复工作。

## 本地开发

按 [私有化部署](README.md#私有化部署) 安装依赖并配置独立开发数据库。不要使用生产数据库进行开发或测试。

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

优先运行受影响模块的检查，例如 `pnpm --filter @rcm/runtime test`。`pnpm check` 包含 lint、类型检查和格式检查，不包含测试与构建。

安装依赖时会通过 Husky 自动启用 Git pre-commit 钩子。提交前 lint-staged 仅使用现有 Prettier 配置格式化暂存文件，并自动更新暂存区；未暂存的修改不纳入提交。格式化失败时提交会中止。已有工作区更新依赖后可执行 `pnpm prepare` 启用钩子。CI 和 Docker 安装依赖时设置 `HUSKY=0`，继续执行原有质量检查。

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

## 版本发布与分支流程

- `main` 为可构建、可部署的主分支；小改动可在本地验证后直接推送，较大功能使用临时 `feat/*` 或 `fix/*` 分支，通过 PR 检查后合并。无需长期维护 test/dev 分支。
- 提交采用 Conventional Commits，例如 `feat(runtime): 增加工作区搜索`、`fix(server): 修复授权异常`；scope 可选，中文描述应准确。不兼容变更使用 `!` 或 `BREAKING CHANGE:`，并说明升级步骤。
- 根 package.json 与发布清单记录产品版本，Release Please 在 main 检查通过后维护发布 PR，并同步各应用及共享包的版本。未计划发布时保持 PR 打开，继续开发即可。
- 正式发布前检查发布 PR 的版本、更新日志、协议兼容性、数据库迁移及配置变化；合并发布 PR 后，main CI 成功才会创建 Tag 和 GitHub Release。不要手动修改发布清单或重复创建 Tag。
- 发布仅包含源码，不自动发 npm 包、Docker 镜像或部署。发布 PR 由默认 GITHUB_TOKEN 创建，PR CI 可能需要人工触发或批准；正式发布仍以 main CI 为门槛。
