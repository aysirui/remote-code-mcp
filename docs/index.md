---
title: 文档与快速开始
description: Remote Code MCP 通用 AI 远程编码工具文档，涵盖 AI 工具接入远程 MCP Server、Docker Compose 自托管和工作区权限。
---

# Remote Code MCP 文档

Remote Code MCP（RCM）是开源、自托管的通用 AI MCP 远程编码工具。AI 客户端通过远程 MCP Server 请求读写文件、查看 Git 差异或运行开发命令，由存放代码的设备上的 Runtime 按工作区授权执行。

## 从这里开始

- [AI 工具接入远程 MCP Server](./connect-clients.md) — 查找 WorkBuddy、豆包和 ChatGPT 的配置入口，验证 OAuth 和首次工具调用。
- [用 Docker Compose 自托管 Remote Code MCP](./deployment.md) — 配置 Server、Console、数据库和反向代理。
- [工作区权限与数据流向](./workspace-permissions.md) — 了解 AI 可以访问哪些文件、哪些操作要审批，以及各组件保存什么。
- [Runtime 使用指南](./usage.md) — 管理工作区、本机命令、多服务器连接和 OAuth 授权。
- [许可证说明](./licensing.md) — 了解项目许可证、版权和分发要求。

## 项目资料

- [快速开始](https://github.com/aysirui/remote-code-mcp/blob/main/README.md#快速开始)
- [安全说明与漏洞报告](https://github.com/aysirui/remote-code-mcp/blob/main/SECURITY.md)
- [贡献指南](https://github.com/aysirui/remote-code-mcp/blob/main/CONTRIBUTING.md)

项目处于早期开发阶段。部署前请阅读安全说明，并在自己的测试环境完成部署指南中的验证。
