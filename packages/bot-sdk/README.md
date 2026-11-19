# @rcm/bot-sdk

面向 Node.js 22+ 的跨平台 TypeScript 机器人 SDK。用同一套 API 为飞书、企业微信和钉钉开发通知机器人、客服助手或 AI Agent：收发私聊文字、主动发送交互卡片、处理原生按钮点击，并按平台能力更新卡片。

SDK 不依赖 RCM 服务，不负责账号绑定、业务审批、持久化或 Agent 编排。应用自行决定向谁发消息，以及如何授权按钮动作。

## 安装

包尚未发布到 npm。当前可在源码仓库根目录生成压缩包，再到你的 Node.js 项目中安装：

```sh
# 在 SDK 源码仓库中
pnpm install
pnpm --filter @rcm/bot-sdk pack

# 在使用 SDK 的项目中，替换为上一步输出的压缩包路径
npm install /path/to/rcm-bot-sdk-0.1.0.tgz
```

安装的是一个包，包含三个平台的依赖。代码只需从所用平台的子路径导入 `createAdapter`；使用打包工具时，未导入的平台不会通过 SDK 入口进入应用 bundle。Node.js 直接运行不会裁剪已安装的依赖。

## 快速上手

下面以飞书为例。先按[平台配置](#平台配置)准备应用凭证和测试用户的 `open_id`，再运行以下 TypeScript ESM 示例：

```ts
import { createBot } from '@rcm/bot-sdk/core'
import { createAdapter } from '@rcm/bot-sdk/adapters/feishu'

const bot = createBot({
  adapters: [
    createAdapter({
      id: 'feishu-test',
      appId: process.env.FEISHU_APP_ID!,
      appSecret: process.env.FEISHU_APP_SECRET!,
    }),
  ],
  onError: (botId, error) => console.error(botId, error.message),
})

const userId = process.env.BOT_DEMO_USER_ID!
bot.onMessage(async ({ conversation, text }) => {
  if (conversation.userId === userId) await bot.sendText(conversation, `收到：${text}`)
})

await bot.start()
try {
  const ref = await bot.sendCard(
    { botId: 'feishu-test', userId },
    {
      title: '测试卡片',
      body: '点击确认，不会执行任何操作。',
      buttons: [{ id: 'confirm', label: '确认' }],
    },
  )
  bot.onAction((event) => {
    if (
      event.botId !== ref.botId ||
      event.cardId !== ref.cardId ||
      event.actorId !== ref.userId ||
      event.actionId !== 'confirm'
    )
      return
    return { card: { title: '测试卡片', body: '已确认', buttons: [] } }
  })
} catch (error) {
  await bot.stop()
  throw error
}
```

应用退出时调用 `await bot.stop()`。只想测试连通性时，可以直接运行下面的内置演示，不用编写代码。

## API

从 `@rcm/bot-sdk/core` 导入 `createBot` 及公共类型；从平台子路径导入 `createAdapter(options)`。同一文件中导入多个平台时，可以使用导入别名区分。

| API                                 | 用途                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `createBot({ adapters, onError? })` | 注册一个或多个适配器，实例 `id` 不可重复。可用 `onError` 接收异步错误。                                           |
| `bot.start()` / `bot.stop()`        | 建立或关闭连接；主动发消息前必须完成启动。                                                                        |
| `bot.onMessage(handler)`            | 订阅单聊文字。事件包含 `conversation`、`messageId` 和 `text`。                                                    |
| `bot.onAction(handler)`             | 订阅原生按钮。事件包含 `botId`、`actorId`、`cardId` 和 `actionId`；可返回 `{ card }` 在回调内替换卡片。           |
| `bot.sendText(conversation, text)`  | 主动向指定用户发送文字。目标 `conversation` 由 `{ botId, userId }` 指定。                                         |
| `bot.sendCard(conversation, card)`  | 主动发卡并返回 `CardRef`。卡片使用 `{ title, body, buttons }`，按钮使用 `{ id, label }`；空按钮数组可用于状态卡。 |
| `bot.updateCard(ref, card)`         | 主动更新卡片。必须传回原始 `CardRef` 对象，不能序列化后重建。                                                     |
| `bot.capabilities(botId)`           | 查询是否支持主动更新（`proactiveCardUpdate`）或回调内更新（`callbackCardUpdate`）。                               |

`onMessage` 和 `onAction` 都返回取消订阅函数；同一 Bot 只能注册一个按钮处理器。点击者的 `actorId` 是平台身份，不是业务授权。应用应校验操作者、卡片、动作、有效期和重复提交，并尽快响应，避免在平台回调中等待耗时任务。

## 平台能力

| 导入子路径                       | 长连接与私聊接收人                             | 点击回调内更新 | 主动更新 |
| -------------------------------- | ---------------------------------------------- | -------------- | -------- |
| `@rcm/bot-sdk/adapters/feishu`   | 国内飞书应用机器人；应用范围内的用户 `open_id` | 支持           | 支持     |
| `@rcm/bot-sdk/adapters/wecom`    | 企业微信智能机器人；企业成员 `userid`          | 支持           | 不支持   |
| `@rcm/bot-sdk/adapters/dingtalk` | 钉钉企业内部应用；指定企业的成员 `staffId`     | 支持           | 支持     |

企微的主动文字接口使用 Markdown，适配器转义常用格式标记。平台仍可能拒绝超过自身大小或数量限制的消息和卡片。

## 平台配置

- **飞书**：创建企业自建应用并启用机器人；使用长连接订阅 `im.message.receive_v1` 和卡片回调 `card.action.trigger`，开通单聊接收和应用发消息权限后发布。适配器接收 `{ id, appId, appSecret }`。测试用户应在应用可用范围内，用户 `open_id` 必须来自同一个应用。测试外部账号时，须先开启对外单聊并由用户建立会话，再分别验证收卡、点击和更新。
- **企业微信**：创建支持长连接的智能机器人，确保测试成员在可用范围内。适配器接收 `{ id, botId, secret }`，其中 `botId` 是企微凭证中的机器人 ID，不是 SDK 实例的 `id`。不要同时运行共享同一凭证的多个实例。
- **钉钉**：开启企业内部应用机器人和 Stream，申请私聊消息及卡片接口权限。适配器接收 `{ id, clientId, clientSecret, corpId, cardTemplateId, robotCode? }`，未配置 `robotCode` 时使用 `clientId`。还需配置下方卡片模板。

### 钉钉模板

在钉钉卡片平台创建并发布应用可用的互动模板，配置 Stream 回传。绑定纯文本标题 `title`、正文 `body`，以及最多两个按钮：

| 按钮   | 标签变量      | 显示条件               | 服务端回传参数               |
| ------ | ------------- | ---------------------- | ---------------------------- |
| 第一个 | `firstLabel`  | `showFirst` 为 `true`  | `botSdkAction` 取 `firstId`  |
| 第二个 | `secondLabel` | `showSecond` 为 `true` | `botSdkAction` 取 `secondId` |

可见性变量在 OpenAPI 的 `cardParamMap` 中以字符串 `"true"` / `"false"` 投递；模板用布尔变量绑定可见性。按钮使用服务端回传事件，参数应出现在 `content.cardPrivateData.params.botSdkAction`。状态卡留空按钮数组。适配器依赖固定版 `dingtalk-stream`（`2.1.6-beta.1`），用于支持可关闭和可重连的 Stream 连接。

## 运行内置演示

安装 SDK 后，在当前终端配置环境变量，然后从项目根目录启动。演示运行包内的 JavaScript，不需要安装 `tsx` 或下载源码。

| 平台     | 安装后运行                               | 环境变量                                                                                                                                                     |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 飞书     | `npx --no-install rcm-bot-demo-feishu`   | `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`BOT_DEMO_USER_ID`（`open_id`）                                                                                        |
| 企业微信 | `npx --no-install rcm-bot-demo-wecom`    | `WECOM_BOT_ID`、`WECOM_SECRET`、`BOT_DEMO_USER_ID`（`userid`）                                                                                               |
| 钉钉     | `npx --no-install rcm-bot-demo-dingtalk` | `DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET`、`DINGTALK_CORP_ID`、`DINGTALK_CARD_TEMPLATE_ID`、`BOT_DEMO_USER_ID`（`staffId`）；可选 `DINGTALK_ROBOT_CODE` |

如果在源码仓库中，可以运行 `pnpm --filter @rcm/bot-sdk demo:feishu`、`demo:wecom` 或 `demo:dingtalk`（后两者使用相同的 `pnpm --filter @rcm/bot-sdk` 前缀）。

启动后会主动向指定用户发送一张五分钟内可处理的模拟审批卡。点击批准或拒绝，确认卡片显示对应状态；在私聊发一句话，确认机器人回复回声。按 `Ctrl+C` 停止。演示不会执行真实操作，也不读取 Runtime 审批或工作区数据。请使用测试凭证，不要把凭证提交到仓库。

## 许可证

AGPL-3.0-only，详见 [LICENSE](./LICENSE)。
