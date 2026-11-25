---
title: WorkBuddy MCP 接入与使用
description: WorkBuddy 自定义连接器接入 Remote Code MCP 官方在线 MCP Server 的配置、OAuth 授权、远程文件与 Git 操作验证指南。
---

# WorkBuddy MCP 接入与使用

通过 WorkBuddy 的自定义连接器接入 RCM 官方在线 MCP Server，在具备相应工具调用能力的会话中远程访问已授权的本地代码工作区。

> 当前 RCM 尚未完成 WorkBuddy 端到端联调，以下步骤为接入验证指南，不代表已确认兼容全部客户端版本。

## 接入前准备

- 在 [官方控制台](https://rcmconsole.aysirui.com/) 注册或登录 RCM 账号。
- 按 [Runtime 使用指南](./usage.md) 启动本机 Runtime，连接官方 Server `https://rcm.aysirui.com`，完成设备配对并授权一个只读测试 Git 仓库。
- 使用与 Runtime 配对相同的 RCM 账号完成 OAuth 授权。

## 配置 WorkBuddy MCP 连接

1. 打开 WorkBuddy 的「连接器」，进入「自定义连接器」的 MCP 服务管理。
2. 添加远程 MCP 服务。若使用 `mcp.json`，将以下 `rcm` 条目合并到原有的 `mcpServers`。

```json
{
  "mcpServers": {
    "rcm": {
      "type": "http",
      "url": "https://rcm.aysirui.com/mcp"
    }
  }
}
```

3. 保存配置。出现认证提示时，进入浏览器完成 RCM 授权，再回到客户端确认是否列出工具。若当前版本只支持手工填写预注册的 OAuth 凭据，先确认它能否使用 RCM 的动态注册流程。

参考 [腾讯设计的 WorkBuddy MCP 接入文档](https://docs.ardot.tencent.com/ardot-mcp/ide-integration.html#workbuddy)。

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
