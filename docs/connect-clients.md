---
description: 将 WorkBuddy、豆包开放平台插件和 ChatGPT 网页聊天接入 Remote Code MCP。了解远程 MCP Server 地址、OAuth 要求和只读验证步骤。
---

# AI 工具接入远程 MCP Server

Remote Code MCP（RCM）把 AI 客户端的工具调用转发到你授权的设备。模型和对话由所选客户端提供，RCM 负责转发和执行文件、Git 与命令操作。代码在另一台设备上，或需要统一管理多台设备的工作区权限时，可以通过同一个 RCM Server 接入。

## 接入前准备

1. [部署 RCM Server 与 Console](./deployment.md)，准备客户端可访问的 HTTPS 地址，例如 `https://rcm.example.com/mcp`。将示例域名替换为你实际部署的 Server 域名。
2. 在存放代码的设备上[配对 Runtime](./usage.md#runtime-配对)，添加一个测试 Git 仓库并保留只读权限。
3. 确认客户端能添加自定义远程 MCP Server，传输方式为 Streamable HTTP，并能完成 OAuth 授权。RCM 使用动态客户端注册（DCR）、授权码和 PKCE（S256），工具权限范围为 `mcp:tools`。

## WorkBuddy

WorkBuddy 的自定义连接器提供远程 HTTP MCP 配置入口。以下配置用于验证 RCM 接入，当前 RCM 尚未完成 WorkBuddy 端到端联调。

1. 打开 WorkBuddy 的「连接器」，进入「自定义连接器」的 MCP 服务管理。
2. 添加远程 MCP 服务。若使用 `mcp.json`，将以下 `rcm` 条目合并到原有的 `mcpServers`。

```json
{
  "mcpServers": {
    "rcm": {
      "type": "http",
      "url": "https://rcm.example.com/mcp"
    }
  }
}
```

3. 保存配置。出现认证提示时，进入浏览器完成 RCM 授权，再回到客户端确认是否列出工具。若当前版本只支持手工填写预注册的 OAuth 凭据，先确认它能否使用 RCM 的动态注册流程。

参考 [腾讯设计的 WorkBuddy MCP 接入文档](https://docs.ardot.tencent.com/ardot-mcp/ide-integration.html#workbuddy)。

## 豆包

豆包开放平台提供通过插件接入远程 MCP 的方式。需要使用具备插件开发或管理权限的账号。RCM 的豆包插件尚未上线，当前指引供开发者联调。

1. 按开放平台的插件开发文档准备插件包，在 `mcp.json` 中配置实际的 RCM `/mcp` 地址。
2. 按平台要求选择支持 DCR 的 OAuth 配置，上传插件包并在可用的测试环境中安装。
3. 在测试对话中调用插件，完成 RCM 账号授权并检查工具列表。只有首次只读调用成功，才算完成接入验证。

参考 [豆包开放平台插件开发文档](https://open.doubao.com/document)。

## ChatGPT 网页聊天

在 OpenAI 支持的地区并具备自定义 MCP 权限时，可以在 ChatGPT 网页端添加 RCM，安装后回到普通聊天中用 `@` 选中插件。通过插件调用本机文件和 Git 工具，无需启动 Work 或 Codex 任务。注册、授权和写入审批步骤见 [ChatGPT 网页聊天远程编码教程](./connect-chatgpt.md)。

## 验证首次只读调用

1. 完成授权后调用 `workspace_list`，确认返回的是当前 RCM 账号授权的测试工作区，并取得 `workspaceId`。
2. 使用该 ID 调用 `file_read` 读取测试仓库中的 `README.md`，再用 `git_status` 查看 Git 状态。
3. 在客户端的工具调用记录和 RCM Console 中核对实际结果。无法列出工具时，按 [MCP 接入验证](./usage.md#mcp-接入验证)检查端点和 OAuth 发现信息。能列出工具而无法读取时，检查 Runtime 的在线状态和工作区权限。

文件正文、Git 差异等工具结果会返回所选 AI 客户端。数据处理方式见[工作区权限与数据流向](./workspace-permissions.md)。
