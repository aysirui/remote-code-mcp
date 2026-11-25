---
description: 在 ChatGPT 网页普通聊天中添加 Remote Code MCP 插件，远程编辑已授权的本地代码、查看 Git 差异，并了解 Chat 与 Work、Codex 的用量区别。
---

# 在 ChatGPT 网页聊天中使用 RCM 远程编码

在 ChatGPT 网页版安装并授权 Remote Code MCP 自定义 MCP 插件后，可以在普通聊天（Chat）中读取本地仓库、讨论修改方案，并在授权后将修改写回本机。文件和 Git 操作由存放代码的电脑上的 Runtime 执行，整个流程无需启动 Work 或 Codex 任务。其他客户端参见 [AI 工具接入指南](./connect-clients.md)。

## 开始前需要什么？

- 已运行的 RCM Server 和 Console。如果从零开始，先完成 [Docker Compose 部署](./deployment.md)。本文使用通过公网 HTTPS 访问的 Server。
- 已启动的 Runtime，安装在存放 Git 仓库的设备上。首次验证用临时 Git 仓库，并准备一份不含私密信息的 `README.md`。
- 在 OpenAI 支持的地区使用 ChatGPT，并且账号具备在网页聊天中添加和使用自定义 MCP 插件的权限。参见 [OpenAI 支持的地区](https://help.openai.com/zh-hans-cn/articles/7947663-chatgpt-and-openai-api-supported-countries-and-territories)和 [自定义 MCP 连接说明](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)。

## 1. 配对 Runtime 并授权测试仓库

1. 打开 Runtime 启动时打印的完整本地管理链接。
2. 在 Runtime 选择 RCM Server 地址，生成配对码。在 Console 登录并确认配对，然后回到 Runtime 完成绑定。
3. 在 Runtime 点击「添加项目」，选择测试仓库，保留默认只读权限。确认 Console 中设备在线、工作区已同步。

各步骤的界面操作见 [Runtime 配对](./usage.md#runtime-配对)。

## 2. 在 ChatGPT 添加 MCP 连接

1. 在有权创建连接的界面选择添加自定义 MCP 服务器，填写名称，例如「Remote Code MCP」。
2. Server URL 填写 RCM Server 的 HTTPS 地址加 `/mcp`，例如 `https://rcm.example.com/mcp`。选择 OAuth，并按界面提示扫描工具、完成登录及授权。OAuth 登录使用与 Runtime 配对时相同的 RCM 平台账号。
3. 安装插件后，回到 ChatGPT 首页，选择 **Chat（聊天）**，新建对话。在输入框输入 `@` 并选中已安装的 RCM 插件。参见 [OpenAI 的网页端 MCP 说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## 3. 验证首次文件读取和 Git 状态

在对话中输入以下指令，把工作区名称替换成 Runtime 中的实际显示名。

```text
调用 Remote Code MCP 的 workspace_list，找到名为「测试仓库」的工作区。
用返回的 workspaceId 调用 file_read 读取 README.md，再调用 git_status 查看 Git 状态。
只执行这三个读取操作。
```

工具调用成功时，`workspace_list` 会返回工作区 ID 和在线状态，`file_read` 会返回文件正文和 SHA-256 摘要，`git_status` 会返回该仓库的 Git 状态。可以在调用明细中核对实际执行的工具，并在 Console 的操作记录中查看工作区调用。请确认读取到的是测试仓库中的 `README.md`。

## 4. 在同一个聊天中修改文件

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
