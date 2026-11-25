---
title: AI 工具接入总览
description: 将 WorkBuddy、豆包开放平台插件和 ChatGPT 网页聊天接入 Remote Code MCP。了解官方在线 MCP Server 地址、OAuth 要求和只读验证步骤。
---

# AI 工具接入总览

Remote Code MCP（RCM）把 AI 客户端的工具调用转发到你授权的设备。模型和对话由所选客户端提供，RCM 负责转发和执行文件、Git 与命令操作。代码在另一台设备上，或需要统一管理多台设备的工作区权限时，可以通过 RCM 官方在线 MCP Server 接入。

## 接入前准备

1. 打开 [官方控制台](https://rcmconsole.aysirui.com/) 注册或登录 RCM 账号。官方在线 MCP Server 地址为 `https://rcm.aysirui.com/mcp`。
2. 在存放代码的设备上[配对 Runtime](./usage.md#runtime-配对)，添加一个测试 Git 仓库并保留只读权限。
3. 确认客户端能添加自定义远程 MCP Server，传输方式为 Streamable HTTP，并能完成 OAuth 授权。RCM 使用动态客户端注册（DCR）、授权码和 PKCE（S256），工具权限范围为 `mcp:tools`。

## 选择 AI 工具

| AI 工具 | 接入方式 | 接入与使用说明 |
| --- | --- | --- |
| WorkBuddy | 自定义连接器，远程 HTTP MCP | [WorkBuddy MCP 接入与使用](./connect-workbuddy.md)（待完成端到端联调） |
| 豆包 | 开放平台插件 | [豆包 MCP 接入与使用](./connect-doubao.md)（开发联调，插件尚未上线） |
| ChatGPT | 网页聊天自定义 MCP 插件 | [ChatGPT 网页聊天远程编码](./connect-chatgpt.md) |

各客户端的配置入口、账号权限和工具调用能力可能不同，请按对应教程操作。

## 验证首次只读调用

1. 完成授权后调用 `workspace_list`，确认返回的是当前 RCM 账号授权的测试工作区，并取得 `workspaceId`。
2. 使用该 ID 调用 `file_read` 读取测试仓库中的 `README.md`，再用 `git_status` 查看 Git 状态。
3. 在客户端的工具调用记录和 [官方控制台](https://rcmconsole.aysirui.com/) 中核对实际结果。无法列出工具时，按 [MCP 接入验证](./usage.md#mcp-接入验证)检查端点和 OAuth 发现信息。能列出工具而无法读取时，检查 Runtime 的在线状态和工作区权限。

文件正文、Git 差异等工具结果会返回所选 AI 客户端。数据处理方式见[工作区权限与数据流向](./workspace-permissions.md)。
