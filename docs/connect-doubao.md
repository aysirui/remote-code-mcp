---
title: 豆包 MCP 接入与使用
description: 豆包开放平台插件接入 Remote Code MCP 官方在线 MCP Server 的开发联调、OAuth 授权与远程工作区工具调用验证指南。
---

# 豆包 MCP 接入与使用

通过豆包开放平台的插件接入方式，验证豆包对话与 RCM 官方在线 MCP Server 的连接。

> RCM 豆包插件尚未上线。本页面向具有插件开发或管理权限的开发者，不代表普通豆包账号已能直接安装 RCM 插件。

## 接入前准备

- 在 [官方控制台](https://rcmconsole.aysirui.com/) 注册或登录 RCM 账号。
- 按 [Runtime 使用指南](./usage.md) 启动本机 Runtime，连接官方 Server `https://rcm.aysirui.com`，完成设备配对并授权一个只读测试 Git 仓库。
- 使用与 Runtime 配对相同的 RCM 账号完成 OAuth 授权。

## 配置豆包开放平台插件

1. 登录 [豆包开放平台](https://open.doubao.com/)，按开放平台的插件开发文档准备插件包，在 `mcp.json` 中配置官方 MCP Server 地址 `https://rcm.aysirui.com/mcp`。
2. 按平台要求选择支持 DCR 的 OAuth 配置，上传插件包并在可用的测试环境中安装。
3. 在测试对话中调用插件，完成 RCM 账号授权并检查工具列表。只有首次只读调用成功，才算完成接入验证。

参考 [豆包开放平台插件开发文档](https://open.doubao.com/document)。

## 使用 RCM 访问本地工作区

完成连接和授权后，在支持调用该 MCP 工具的对话中输入：

```text
调用 RCM 的 workspace_list，找到名为「测试仓库」的工作区。
使用返回的 workspaceId 调用 file_read 读取 README.md，再调用 git_status 查看 Git 状态。
仅执行上述读取操作，不修改文件。
```

将「测试仓库」替换为 Runtime 中的实际工作区名称。在客户端工具调用记录和 [官方控制台](https://rcmconsole.aysirui.com/) 核对结果。

首次只读调用成功后，可以在 Runtime 中开启测试工作区的写入权限，将 File 策略设为「审批执行」，再请求 AI 修改测试文件。写入已有文件时应先读取文件并使用返回的 SHA-256 作为 expectedSha256，核对本机审批内容后再批准。具体规则见 [工作区权限与数据流向](./workspace-permissions.md)。

## 常见问题

- 无法添加服务或完成 OAuth：确认客户端支持远程 Streamable HTTP、动态客户端注册（DCR）、授权码及 PKCE（S256）。参见 [MCP 接入验证](./usage.md#mcp-接入验证)。
- 工作区列表为空：确认授权账号与 Runtime 配对账号一致，目标工作区已经授权。
- 文件读取失败：确认设备在线、工作区启用且 File 策略允许读取。

[返回 AI 工具接入总览](./connect-clients.md)。
