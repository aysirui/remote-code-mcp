---
title: WorkBuddy MCP 接入与使用
description: 在腾讯 WorkBuddy 中添加 RCM 自定义 MCP 连接器，完成 OAuth 授权，通过聊天远程访问本地代码工作区、修改文件和执行 Git 操作。
---

# WorkBuddy MCP 接入与使用

通过 WorkBuddy 的自定义连接器接入 Remote Code MCP（RCM）官方在线 MCP Server，即可在聊天中访问已授权设备的代码工作区。文件、Git 和命令操作由目标设备上的 Runtime 执行。

本文的连接配置、OAuth 授权及设备和工作区列表查询已在 WorkBuddy v5.8.3 中验证。不同版本的界面可能略有差异。

## 接入前准备

- 在 [官方控制台](https://rcmconsole.aysirui.com/) 注册或登录 RCM 账号。
- 按 [Runtime 使用指南](./usage.md) 启动目标设备上的 Runtime，连接官方 Server `https://rcm.aysirui.com`，完成设备配对并授权测试工作区。
- 安装并登录 WorkBuddy。首次验证建议使用只读测试工作区。

## 1. 添加自定义连接器

打开 WorkBuddy，依次进入：

**专家 · 技能 · 连接器 → 连接器 → 自定义连接器**

左侧导航进入「专家 · 技能 · 连接器」，在页面顶部切换到「连接器」标签，再点击右上角的「自定义连接器」，进入 MCP 服务管理界面。

点击右上角「添加 MCP」，进入 `mcp.json` 配置编辑界面。

## 2. 配置 RCM MCP Server

在 `mcp.json` 中添加以下配置：

```json
{
  "mcpServers": {
    "rcm": {
      "type": "streamableHttp",
      "url": "https://rcm.aysirui.com/mcp",
      "timeout": 30000
    }
  }
}
```

| 配置项    | 说明                                               |
| --------- | -------------------------------------------------- |
| `rcm`     | 连接器名称，便于在聊天中指定使用 RCM。             |
| `type`    | 使用 Streamable HTTP 传输方式。                    |
| `url`     | RCM 官方在线 MCP Server 地址。                     |
| `timeout` | 客户端请求超时时间，单位为毫秒，此处设置为 30 秒。 |

如果已有其他 MCP 服务，只需将 `rcm` 条目合并到原有的 `mcpServers` 对象中，不要覆盖其他连接器配置。

## 3. 启用连接器并完成 OAuth 授权

1. 编辑完成后，返回 MCP 服务列表，开启 `rcm` 右侧的开关。
2. WorkBuddy 提示进行授权时，点击「连接」按钮，浏览器将打开 RCM OAuth 授权页面。
3. 如需登录，请使用与 Runtime 配对时相同的 RCM 账号。确认当前账号、客户端名称（WorkBuddy Connector）、授权范围（`mcp:tools`）及 WorkBuddy 本地应用回调地址。
4. 点击「同意授权并继续」。浏览器会尝试打开 WorkBuddy；如果浏览器弹出打开本地应用的确认提示，请确认来源可信后允许打开。
5. 返回 WorkBuddy，确认 `rcm` 已启用。

OAuth 授权并不意味着 AI 可以访问电脑上的任意文件。实际操作仍受 Runtime 的工作区授权、读写权限及审批策略限制。

## 4. 确认 MCP 工具加载成功

返回「MCP 服务管理」，展开 `rcm`。连接成功时，连接器旁显示绿色状态标识，且可以看到已启用的工具列表。

本次验证中显示 16/16 个工具已启用，包括：

| 工具类别     | 工具                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------- |
| 设备与工作区 | `device_list`、`workspace_list`                                                                 |
| 文件         | `file_list`、`file_read`、`file_search`、`file_write`、`file_mkdir`、`file_move`、`file_delete` |
| Git          | `git_status`、`git_log`、`git_diff`、`git_add`、`git_commit`                                    |
| 命令         | `command_list`、`command_run`                                                                   |

工具数量以当前服务版本实际返回为准。

## 5. 在聊天中使用 RCM

完成授权后，关闭 MCP 服务管理窗口，新建任务即可通过自然语言指定使用 RCM 连接器，无需手动填写工作区 ID 或工具参数。

### 查看设备和工作区

```text
使用 rcm 连接器查看设备列表和工作区列表。
```

WorkBuddy 会调用 RCM 查询当前账号下的设备及已授权工作区，并展示查询结果。设备在线状态与工作区权限可以帮助你选择后续操作的目标。

### 读取代码文件

```text
使用 rcm 工具读取 rcm-test 工作区中的 README.md，并介绍这个项目的用途，不要修改文件。
```

### 修改工作区文件

先在 Runtime 中开启目标测试工作区的写入权限，首次写入建议使用审批策略。

```text
使用 rcm 工具修改 rcm-test 工作区中的 README.md，
在末尾添加一行“通过 WorkBuddy 更新”。
先读取文件，再进行修改，完成后重新读取确认结果。
不要提交 Git。
```

将示例中的工作区名称、文件路径和修改要求替换为实际内容。若 Runtime 要求审批，请在本机核对操作后批准。修改已有文件时，应使用读取结果中的 SHA-256 进行写入版本检查。

### 查看 Git 状态

```text
使用 rcm 查看 rcm-test 工作区的 Git 状态和未提交的代码差异，不要修改文件。
```

如需操作另一台设备上的代码，只需指定该设备已授权且在线的工作区。可以在 WorkBuddy 的工具调用记录及 [官方控制台](https://rcmconsole.aysirui.com/) 的操作记录中核对执行情况。

## 常见问题

| 现象                     | 处理方式                                                                |
| ------------------------ | ----------------------------------------------------------------------- |
| 开启 RCM 后无法连接      | 检查 `mcp.json` 格式、`streamableHttp` 类型及官方 `/mcp` 地址。         |
| 授权后未返回 WorkBuddy   | 检查浏览器是否阻止打开本地应用，允许可信的 WorkBuddy 回调后返回客户端。 |
| 未显示工具列表           | 确认 OAuth 授权完成，在 MCP 服务管理中刷新 RCM 连接器。                 |
| 工作区列表为空           | 确认 OAuth 使用的 RCM 账号与 Runtime 配对账号一致，并已授权工作区。     |
| 工作区存在但文件操作失败 | 检查目标设备是否在线、工作区是否启用及读写权限和审批策略。              |

更多权限说明见 [工作区权限与数据流向](./workspace-permissions.md)。

[返回 AI 工具接入总览](./connect-clients.md)。
