---
title: ChatGPT MCP 接入与使用
description: 在 ChatGPT 网页或桌面客户端添加 Remote Code MCP 插件，远程编辑已授权的本地代码、查看 Git 差异，并了解 Chat 与 Work、Codex 的用量区别。
---

# ChatGPT MCP 接入与使用

在 ChatGPT 网页或桌面客户端安装并授权 Remote Code MCP 自定义 MCP 插件后，可以在普通聊天（Chat）中读取本地仓库、讨论修改方案，并在授权后将修改写回本机。文件和 Git 操作由存放代码的电脑上的 Runtime 执行，整个流程无需启动 Work 或 Codex 任务。其他客户端参见 [AI 工具接入总览](./connect-clients.md)。

## 开始前需要什么？

- 已在 [官方控制台](https://rcmconsole.aysirui.com/) 注册或登录 RCM 账号。本文使用官方在线 MCP Server（`https://rcm.aysirui.com/mcp`）。
- 已按 [Runtime 使用指南](./usage.md#runtime-配对) 启动 Runtime、配对设备并添加已授权工作区。首次验证用临时 Git 仓库，并准备一份不含私密信息的 `README.md`。
- 在 OpenAI 支持的地区使用 ChatGPT，并且账号具备在聊天中添加和使用自定义 MCP 插件的权限。参见 [OpenAI 支持的地区](https://help.openai.com/zh-hans-cn/articles/7947663-chatgpt-and-openai-api-supported-countries-and-territories)和 [自定义 MCP 连接说明](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)。

## 1. 添加自定义 MCP 服务器

以下以 ChatGPT 网页端为例。桌面客户端的添加方式类似。

**设置 → 插件 → 浏览目录 → 添加 → 添加自定义 MCP 服务器**

1. 打开 ChatGPT 设置，在左侧「集成」下选择「插件」。
2. 点击右上角「浏览目录」，进入插件目录。也可以从 ChatGPT 主界面左侧「插件」直接进入。
3. 点击右上角「添加」，选择「添加自定义 MCP 服务器」。

## 2. 配置 RCM 并完成 OAuth 授权

在添加自定义 MCP 服务器的表单中填写：

| 配置项 | 填写内容 |
| --- | --- |
| 图标（可选） | PNG 格式，建议 256 × 256 像素或更大，不超过 10 KB |
| 名称 | `rcm` 或 Remote Code MCP |
| 描述（可选） | 访问已授权工作区的文件、Git 和开发命令 |
| 连接 | 服务器 URL（不是隧道） |
| 服务器 URL | `https://rcm.aysirui.com/mcp` |
| 身份验证 | OAuth |
| 高级 OAuth 设置 | 使用默认自动发现配置 |

阅读自定义 MCP 服务器的风险提示，仅在确认信任服务后勾选「我已了解，并希望继续」，按界面提示完成添加。

添加后连接 RCM，ChatGPT 将跳转到 RCM OAuth 授权页面。使用与 Runtime 配对时相同的 RCM 账号登录，核对客户端、回调地址及权限范围，点击「同意授权并继续」，返回 ChatGPT 并等待连接成功。

::: tip 网页与桌面客户端共用
在同一个 ChatGPT 账号及工作空间下，网页端添加的 RCM 插件可以在支持该插件的桌面客户端中使用，反过来也一样，不需要分别重复添加。具体可用性以客户端版本及账号权限为准。
:::

## 3. 在聊天模式中使用 RCM

回到 ChatGPT，选择 **Chat（聊天）** 模式，新建对话。在输入框通过 `@` 选择已安装的 RCM 插件，然后输入自然语言指令。

```text
使用 rcm 工具查看设备列表和工作区列表。
```

不需要启动 Work 或 Codex 任务。设备配对、工作区授权及审批等通用操作参见 [Runtime 使用指南](./usage.md)；已授权 AI 客户端和执行记录参见 [Console 使用指南](./console.md)。

## 4. 验证首次文件读取和 Git 状态

在对话中输入以下指令，把工作区名称替换成 Runtime 中的实际显示名。

```text
调用 Remote Code MCP 的 workspace_list，找到名为「测试仓库」的工作区。
用返回的 workspaceId 调用 file_read 读取 README.md，再调用 git_status 查看 Git 状态。
只执行这三个读取操作。
```

工具调用成功时，`workspace_list` 会返回工作区 ID 和在线状态，`file_read` 会返回文件正文和 SHA-256 摘要，`git_status` 会返回该仓库的 Git 状态。可以在调用明细中核对实际执行的工具，并在 [官方控制台](https://rcmconsole.aysirui.com/) 的操作记录中查看工作区调用。请确认读取到的是测试仓库中的 `README.md`。

## 5. 在同一个聊天中修改文件

在 Runtime 给测试工作区开启写入权限，并将 File 策略设为「审批执行」。选用已经提交到 Git 的 `README.md`，以便写入后查看未暂存差异。

```text
读取测试仓库的 README.md，在末尾加一行「通过 ChatGPT 聊天模式更新」。
用 file_read 返回的 sha256 作为 file_write 的 expectedSha256，提交文件写入审批。
写入成功后调用 git_diff 查看修改，不要暂存或提交。
```

在 Runtime 核对并批准收到的读取和写入请求，然后在聊天中检查返回的 Git 差异。按需调整测试工作区的权限，参见[工作区权限与数据流向](./workspace-permissions.md)。

下面是临时 Git 工作区经 Runtime 审批写入后返回的新增行，分别是一行空行和提示文字。

```diff
+
+通过 ChatGPT 聊天模式更新
```

## 聊天模式编码会用到 Work 或 Codex 的额度吗？

在 Chat 与 Work／Codex 分开计量的账号上，在普通聊天中直接调用 RCM 按 Chat 的规则计量。**5 小时**与**每周（7 天）**是部分套餐的 Work／Codex 用量周期。参见 [Work 和 Codex 用量周期](https://help.openai.com/en/articles/20001498-how-resets-work-in-codex)。

OpenAI 已公告将从 2026 年 12 月起，为 Plus、Pro 和 Business 提供 ChatGPT 与 Codex 的共享用量。该公告说明 Instant Chat 不计入共享用量，其他使用按所选模型和任务计量。插件是否可用及用量如何计入，以账号实际显示和「设置 → 用量」为准。参见 [ChatGPT 与 Codex 用量说明](https://help.openai.com/en/articles/20001625-understanding-chatgpt-and-codex-usage-limits)。

## 连接成功但看不到工作区怎么办？

| 现象                           | 检查位置                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 扫描不到工具或 OAuth 失败      | 核对填入的是 Server 的 `/mcp` 地址，并按 [MCP 接入验证](./usage.md#mcp-接入验证)检查健康接口和 OAuth 元数据。 |
| 工作区列表为空或缺少目标仓库   | 确认 ChatGPT 的 OAuth 授权使用了同一个 RCM 账号，并在 Runtime 中为当前 Server 授权该工作区。                  |
| 工作区存在但调用失败           | 检查 Runtime 是否在线、工作区是否启用，以及相应的 File 或 Git 策略是否允许读取。                              |
| 更新服务后工具列表仍显示旧版本 | 在 ChatGPT 的连接详情刷新工具，再启动新对话验证。                                                             |
