# @rcm/bot-sdk

面向 Node.js 22+ 的跨平台 TypeScript 机器人 SDK。用同一套 API 为飞书、企业微信和钉钉开发通知机器人、客服助手或 AI Agent：收发私聊和群聊文字、主动发送交互卡片、处理原生按钮点击，并按平台能力更新卡片。

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

安装的是一个包，包含三个平台的依赖。每个平台有一个公开入口，应用只导入要连接的平台。平台入口声明该平台支持的能力，打包时可能包含这些实现。只有安装过的能力会注册事件并收发消息。Node.js 直接运行时保留已安装的依赖。

## 快速上手：用飞书发一条文字

准备 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`，以及接收者的飞书 `open_id`（示例中通过 `BOT_DEMO_USER_ID` 读取）。在 Node.js 22+ 的 TypeScript ESM 项目中运行：

```ts
import { createAdapter } from '@rcm/bot-sdk/adapters/feishu'
import { createBot } from '@rcm/bot-sdk/core'
import { TextCapability } from '@rcm/bot-sdk/text'

const feishu = createAdapter({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
})
const bot = createBot({ adapter: feishu })
const messages = bot.install(new TextCapability())

await bot.start()
try {
  await messages.send(process.env.BOT_DEMO_USER_ID!, '你好！')
} finally {
  await bot.stop()
}
```

`createAdapter()` 根据平台凭证配置一条连接。`createBot()` 接管这条连接，`bot.start()` 建立连接。安装文本能力后，`messages.send(userId, text)` 只需要接收者在该平台的用户 ID。

### 收到消息时自动回复

用同一个 `messages` 注册回调。在上例的 `await bot.start()` 前添加：

```ts
messages.onMessage(async ({ conversation, actorId, text }) => {
  if (actorId === process.env.BOT_DEMO_USER_ID) await messages.send(conversation, `收到：${text}`)
})
```

持续接收消息时，让应用保持运行，在退出时再调用 `bot.stop()`。回调里的 `conversation` 已包含来源连接和发送者，可以直接用于回复。

### 发一张卡片

用上例的 `bot`，从 `@rcm/bot-sdk/cards` 导入 `CardCapability`，在启动前安装一次：

```ts
const cards = bot.install(new CardCapability())
```

启动后调用：

```ts
await cards.send(process.env.BOT_DEMO_USER_ID!, {
  title: '任务提醒',
  body: '请确认已收到。',
  buttons: [{ id: 'confirm', label: '确认' }],
})
```

处理按钮时使用 `cards.onAction(handler)`。企微和钉钉的卡片配置见下文。

SDK 导出 `defaultCard` 作为通用双按钮预置，文案为「按钮1」「按钮2」，动作 ID 为 `button1`、`button2`。应用可通过对象展开定制标题、正文和按钮，并自行注册事件：

```ts
import { defaultCard } from '@rcm/bot-sdk/cards'

await cards.send(userId, {
  ...defaultCard,
  title: '操作审批',
  body: '请确认本次操作。',
  buttons: [
    { id: 'approve', label: '批准', style: 'primary' },
    { id: 'deny', label: '拒绝', style: 'secondary' },
  ],
})
// 在 cards.onAction 中校验点击者、有效期和动作，再调用应用自己的审批服务。
```

预置不包含业务状态机或审批处理器。请通过新对象覆盖预置，不要原地修改共享预置。

### 私聊与群聊

`Conversation` 明确区分会话目标，避免将群 ID 当作用户 ID。已有 `messages.send(userId, text)`、`cards.send(userId, card)` 和 `{ botId, userId }` 均继续表示私聊。发送群消息或群卡时使用：

```ts
const group = { botId: 'dingtalk', type: 'group' as const, chatId: '群 openConversationId' }
await messages.send(group, '群消息')
const ref = await cards.send(
  group,
  {
    title: '协作提醒',
    body: '请选择操作。',
    buttons: [{ id: 'acknowledge', label: '收到' }],
  },
  { templateId: '已发布模板 ID' },
)
```

飞书群 ID 为 `chat_id`（`oc_…`），企微群 ID 为 `chatid`，钉钉群 ID 为 `openConversationId`。平台仍要求机器人在群内且具有相应权限；SDK 不会绕过平台权限。

`onMessage` 提供 `conversation` 和独立的 `actorId`。群消息中前者是群目标，后者是发送人；使用 `messages.send(event.conversation, text)` 会回复原群。`onAction` 同样提供点击者 `actorId`，以及可获得时的 `conversation`：优先采用平台上下文，平台字段缺失时使用本进程发卡记录。无法确定会话时保留未指定，不根据点击者猜测为私聊。回调可提供原始 `chatId`（例如飞书的当前聊天 ID），它与发卡记录中的目标分别保留，不能仅凭存在聊天 ID 就认定为群聊。

SDK 不限定哪些用户可以点击群卡，不限定只能处理审批；应用应在回调中自行核验点击者、会话、有效期及动作。RCM Server 自己保留私聊绑定与审批规则。

企微 `WecomCardOptions.updateScope` 可设为 `actor`（默认，仅更新点击者的卡）或 `all`（更新全部接收者，适合共享群卡结果）。无按钮通知卡仍必须提供 `textNoticeUrl`。飞书可通过 `messagePolicy` 配置是否要求提及、群白名单等平台消息策略，默认不要求群消息提及机器人。平台消息订阅和授权范围仍生效。

自定义平台适配器的 `TextAdapter.send` 和 `CardAdapter.send` 现在接收完整 `Conversation`，需要按 `type` 使用 `userId` 或 `chatId`；不能再将第一个参数当作字符串。

### 同时运行多个机器人

每个机器人调用一次 `createBot()`，再交给 `BotManager` 统一安装能力、启动和关闭。

```ts
import { BotManager, createBot } from '@rcm/bot-sdk/core'
import { TextCapability } from '@rcm/bot-sdk/text'
import { CardCapability } from '@rcm/bot-sdk/cards'

// feishu、wecom、dingtalk 是各平台 createAdapter() 的返回值。
const feishuBot = createBot({ adapter: feishu })
const wecomBot = createBot({ adapter: wecom })
const dingtalkBot = createBot({ adapter: dingtalk })

const manager = new BotManager({ bots: [feishuBot, wecomBot, dingtalkBot], retryAfterMs: 30_000 })
const texts = manager.install(() => new TextCapability())
const cards = manager.install(() => new CardCapability())
await manager.start()

const feishuText = texts.get('feishu')!
const dingCards = cards.get('dingtalk')!
// 应用退出时调用 await manager.stop()
```

`manager.install(factory)` 为每个 Bot 调用一次工厂，返回按机器人 ID 查询的能力实例。工厂参数是当前 Bot，可用它的 `id` 配置该机器人的能力。每次调用工厂都应返回新实例。只给一个机器人安装能力时，直接调用该机器人的 `bot.install()`。

`createAdapter()` 默认用平台名作为机器人 ID。只有在同一个管理器里登记多个同平台机器人时，才需要传 `id` 区分，例如 `feishu-prod` 和 `feishu-test`。

凭证和接收者信息见[平台配置](#平台配置)。也可直接运行内置演示。

## 卡片模板与跳转链接

- **飞书**直接传卡片标题、正文和按钮。
- **钉钉**用 `{ templateId }` 指定后台已发布的模板，也可以设置模板变量名来对应标题、正文和按钮。
- **企业微信**用 `{ textNoticeUrl }` 指定无按钮通知卡的有效 HTTP(S) 链接；智能机器人接口要求通知卡带有效跳转，不接受 `card_action.type = 0`。

发卡时直接把平台选项作为第三个参数：

```ts
const template = { templateId: process.env.DINGTALK_CARD_TEMPLATE_ID! }
await dingCards.send(
  dingUserId,
  { title: '任务提醒', body: '请查看待办事项。', buttons: [] },
  template,
)
```

同一种卡片发很多次时，可以用 `const reminders = dingCards.withOptions(template)`，之后调用 `reminders.send(userId, card)`。SDK 发卡时校验并保存该次配置和会话目标，更新和点击回调会继续使用它们。点击回调可以查找最近最多 10,000 张卡片的配置和原始会话，记录保存在当前进程内。

## API 速查

| API                                       | 用途                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `createBot({ adapter, onError? })`        | 创建一个平台机器人，可用 `onError` 接收异步错误。                                                       |
| `bot.start()` / `bot.stop()`              | 建立或关闭连接；主动发消息前必须完成启动。                                                              |
| `new BotManager({ bots, retryAfterMs? })` | 统一启停多个机器人。可通过 `get(id)` 查找机器人。                                                       |
| `manager.install(factory)`                | 在启动前给所有 Bot 安装能力，返回各 Bot 的能力实例。                                                    |
| `bot.isConnected()`                       | 查询当前机器人是否已完成连接。                                                                          |
| `bot.install(capability)`                 | 安装能力并返回对应实例。请在启停切换之外的停止状态安装。                                                |
| `messages.onMessage(handler)`             | 订阅私聊及群聊文字。事件包含 `conversation`、`actorId`、`messageId` 和 `text`。                         |
| `messages.send(userId, text)`             | 主动向平台用户发送文字。回复时也可直接传入收到的会话。                                                  |
| `cards.onAction(handler)`                 | 订阅原生按钮。事件包含 `botId`、`actorId`、`cardId` 和 `actionId`，可返回 `{ card }` 在回调内替换卡片。 |
| `cards.send(userId, card, options?)`      | 主动发卡并返回 `CardRef`，第三个参数可指定平台卡片配置。                                                |
| `cards.update(ref, card)`                 | 主动更新卡片。传回原始 `CardRef` 对象，SDK 沿用发送时的配置。                                           |
| `cards.settle(ref, card, options?)`       | 尝试主动更新或使用已保留的回调窗口，返回 `updated`、`callback` 或 `unavailable`。                       |
| `cards.capabilities()`                    | 查询当前机器人支持的卡片更新方式。                                                                      |

`BotManager.start()` 分别尝试启动各个机器人，已就绪的机器人可继续收发。传入 `retryAfterMs` 时，连接失败的机器人会单独重试。使用单个 `bot.start()` 时，连接失败会直接抛出错误。

能力不支持时抛出 `UnsupportedCapabilityError`，卡片配置缺失或不匹配时抛出 `BotConfigurationError`。接入新平台时，实现核心 `BotAdapter`，并根据平台支持情况，通过 `@rcm/bot-sdk/text` 的 `textAdapter` 键或 `@rcm/bot-sdk/cards` 的 `cardAdapter` 键声明实现工厂。

内置文本和卡片能力位于源码的 `src/core/capabilities`，共用 `BotCapability` 基类。需要为新能力复用平台连接校验和监听生命周期时，可从 `@rcm/bot-sdk/core` 导入并继承 `BotCapability`。也可以直接实现 `Capability`，通过 `attach` 读取 Bot 的平台连接，再在 `start` 中登记监听、在 `stop` 中释放监听。

按钮顺序与动作由调用方决定。用 `visible` 传入当前业务状态下的可见性，默认显示。例如：

```ts
buttons: [
  { id: 'snooze', label: '稍后提醒', visible: canSnooze },
  { id: 'resolve', label: '标为完成', style: 'primary' },
]
```

`cards.onAction` 将按钮的 `id` 作为 `actionId` 交回应用。应用按动作 ID 执行业务，并重新核验点击权限。隐藏按钮只影响卡片的显示，已经发出的旧卡仍可能收到点击。

`onMessage` 和 `onAction` 都返回取消订阅函数；同一 Bot 只能注册一个按钮处理器。点击者的 `actorId` 是平台身份，不是业务授权。应用应校验操作者、卡片、动作、有效期和重复提交，并尽快响应，避免在平台回调中等待耗时任务。

业务结果异步返回时，可在按钮事件通过校验后调用 `event.deferCardUpdate?.()` 保留回调窗口。业务拒绝该操作时，调用返回的取消函数。得到结果后调用 `cards.settle(ref, card)`。返回 `callback` 表示内容已交付给回调处理器，平台确认由适配器负责。仅当主动更新和有效点击回调窗口均不可用时，才补发结算文本。若需要补发，在创建 `CardCapability` 时传入 `{ sendText: (to, text) => messages.send(to, text) }`，再在对应的 `settle` 调用中传入 `{ resultText: async () => '已完成' }`。

## 平台能力

| 导入子路径                       | 长连接与会话目标                                           | 点击回调内更新 | 主动更新 |
| -------------------------------- | ---------------------------------------------------------- | -------------- | -------- |
| `@rcm/bot-sdk/adapters/feishu`   | 国内飞书应用机器人；用户 `open_id` 或群 `chat_id`          | 支持           | 支持     |
| `@rcm/bot-sdk/adapters/wecom`    | 企业微信智能机器人；成员 `userid` 或群 `chatid`            | 支持           | 不支持   |
| `@rcm/bot-sdk/adapters/dingtalk` | 钉钉企业内部应用；成员 `staffId` 或群 `openConversationId` | 支持           | 支持     |

企微的主动文字接口使用 Markdown，适配器转义常用格式标记。平台仍可能拒绝超过自身大小或数量限制的消息和卡片。

按钮可选 `style`。企微将 `primary` 映射为蓝底白字，将 `secondary` 映射为浅底深字。省略时使用客户端默认样式。

## 平台配置

- **飞书**：创建企业自建应用并启用机器人；使用长连接订阅 `im.message.receive_v1` 和卡片回调 `card.action.trigger`，开通单聊接收和应用发消息权限后发布。适配器接收 `{ id, appId, appSecret, messagePolicy? }`；`messagePolicy` 可设置群白名单、是否要求提及等平台策略，默认不额外要求群消息提及。测试用户应在应用可用范围内，用户 `open_id` 必须来自同一个应用。测试外部账号时，须先开启对外单聊并由用户建立会话，再分别验证收卡、点击和更新。
- **企业微信**：创建支持长连接的智能机器人，确保测试成员在可用范围内。适配器接收 `{ id, botId, secret }`，其中 `botId` 是企微凭证中的机器人 ID。无按钮的通知卡（包括点击后替换的卡片）必须传入 `textNoticeUrl`，生成 `card_action.type = 1` 及有效链接。实际智能机器人接口会以 `42045` 拒绝 `type = 0`，不能仅依赖上游 SDK 的类型声明。正文中最多六条形如「标签：内容」的行用原生字段展示。不要同时运行共享同一凭证的多个实例。
- **钉钉**：开启企业内部应用机器人和 Stream，申请使用场景对应的私聊、群聊消息及卡片接口权限，并把机器人添加到目标群。适配器接收 `{ id, clientId, clientSecret, corpId, robotCode? }`，未配置 `robotCode` 时使用 `clientId`。发卡时传入含 `templateId` 的选项。

### 钉钉模板

在钉钉卡片平台创建并发布应用可用的互动模板，配置 Stream 回传。绑定纯文本标题 `title` 和正文 `body`。默认模板提供两个按钮槽：

| 按钮组件 ID | 标签变量      | 显示条件               | 可选服务端回传参数           |
| ----------- | ------------- | ---------------------- | ---------------------------- |
| `button1`   | `firstLabel`  | `showFirst` 为 `true`  | `botSdkAction` 取 `firstId`  |
| `button2`   | `secondLabel` | `showSecond` 为 `true` | `botSdkAction` 取 `secondId` |

数组中的第一个按钮对应第一个模板槽，模板决定槽位的实际位置。隐藏某个按钮时，后面的按钮仍使用各自的槽位。SDK 仅按数组顺序映射通用槽位，不决定业务动作。

自定义模板可在卡片绑定中使用 `titleVariable` 和 `bodyVariable` 覆盖标题与正文变量，使用 `buttonSlots` 指定每个槽的 `componentId`、`labelVariable`、`visibleVariable` 和 `actionIdVariable`。`componentId` 是模板编辑器中的按钮组件 ID；默认依次为 `button1`、`button2`，不是显示文案或动作变量名。数组长度决定该模板可接收多少个按钮。如果模板使用其他回传参数名，通过 `buttonActionParam` 指定，默认 `botSdkAction`。

可见性变量在 OpenAPI 的 `cardParamMap` 中以字符串 `"true"` / `"false"` 投递。模板用布尔变量绑定可见性。按钮必须配置为服务端回传事件。SDK 优先将 `content.cardPrivateData.actionIds` 中的单个组件 ID 映射为该槽当前的业务动作，无需额外回传参数；未匹配组件 ID 的旧模板仍使用 `content.cardPrivateData.params` 中的显式动作参数。使用参数方式时，回传参数值必须绑定该槽的动作变量，不能把 `firstId` / `secondId` 当成字面值或固定为某个业务动作。修改模板后应重新发布并发送新卡验证。状态卡留空按钮数组。适配器依赖固定版 `dingtalk-stream`（`2.1.6-beta.1`），用于支持可关闭和可重连的 Stream 连接。

`IM_ROBOT` 是发送时的投放场域，点击回调不保证包含同值的 `spaceType`，不能把该相等条件作为回调前置要求。SDK 同时处理群聊和私聊回调，校验企业、点击者字段及模板配置；不通过 `spaceType` 限制业务场景。应用仍须核验点击者是否有权执行该动作。

## 运行内置演示

安装 SDK 后，在当前终端配置环境变量，然后从项目根目录启动。演示运行包内的 JavaScript，不需要安装 `tsx` 或下载源码。

| 平台     | 安装后运行                               | 环境变量                                                                                                                                                     |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 飞书     | `npx --no-install rcm-bot-demo-feishu`   | `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`BOT_DEMO_USER_ID`（`open_id`）                                                                                        |
| 企业微信 | `npx --no-install rcm-bot-demo-wecom`    | `WECOM_BOT_ID`、`WECOM_SECRET`、`BOT_DEMO_USER_ID`（`userid`）                                                                                               |
| 钉钉     | `npx --no-install rcm-bot-demo-dingtalk` | `DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET`、`DINGTALK_CORP_ID`、`DINGTALK_CARD_TEMPLATE_ID`、`BOT_DEMO_USER_ID`（`staffId`）；可选 `DINGTALK_ROBOT_CODE` |

如果在源码仓库中，可以运行 `pnpm --filter @rcm/bot-sdk demo:feishu`、`demo:wecom` 或 `demo:dingtalk`（后两者使用相同的 `pnpm --filter @rcm/bot-sdk` 前缀）。

启动后会主动向指定用户发送一张五分钟内可处理的通用双按钮卡。点击「按钮1」或「按钮2」，确认原卡显示所选按钮；在所选会话中由测试用户发一句话，确认机器人回复回声。按 `Ctrl+C` 停止。演示不会执行真实操作，也不读取 Runtime 审批或工作区数据。请使用测试凭证，不要把凭证提交到仓库。

### 用现有模板验证按钮回调

钉钉 demo 默认组件 ID 为 `button1`、`button2`。如果已发布模板的组件 ID 为 `reject`、`agree`，在 PowerShell 中配置后运行（仍显示通用文案「按钮1」「按钮2」，不执行审批）：

```powershell
$env:DINGTALK_DEMO_BUTTON_IDS = 'reject,agree'
# 如凭证已配置在 apps/server/.env，可先在仓库根目录构建，再直接运行 demo。
pnpm --filter @rcm/bot-sdk build
node --env-file=apps/server/.env packages/bot-sdk/dist/demo/dingtalk.js
```

变量必须与已发布模板一致：`firstLabel`、`secondLabel`、`showFirst`、`showSecond`、`firstId`、`secondId`；两个按钮的 `botSdkAction` 参数值分别绑定 `firstId`、`secondId` 变量。`DINGTALK_DEMO_BUTTON_IDS` 只覆盖组件 ID，不改变 SDK 的业务动作。不要同时运行使用同一凭证的 Server 和 demo。

企微运行 `node --env-file=apps/server/.env packages/bot-sdk/dist/demo/wecom.js`。demo 为结果卡指定项目仓库链接，避免打开部署环境的控制台路径。

`src/demo/demo.ts` 中的 `cards.onAction` 是可运行的通用回调示例：核验点击者、机器人、卡片和有效期，读取 `actionId`，然后通过 `cards.settle` 替换原卡。每次启动测试一个按钮，再重启测试另一个按钮；首次选择会保留，重复点击不应改变结果。

演示中的事件处理顺序如下；`select` 是绑定当前测试用户、机器人、卡片和有效期的 `demoSelection` 返回值，`ref` 是发卡引用：

```ts
cards.onAction(async (event) => {
  const choice = select(event)
  if (!choice) return
  const body = choice === 'expired' ? '卡片已过期' : `已选择 ${choice}`
  // 企微需在点击窗口内返回结果，钉钉使用主动更新接口。
  event.deferCardUpdate?.()
  const settlement = await cards.settle(ref, {
    title: '按钮事件结果',
    body,
    buttons: [],
  })
  console.log('结果交付方式：', settlement)
})
```

可选设置 `BOT_DEMO_CHAT_ID` 为对应平台的群 ID，让三个平台的同一套 demo 向群发卡；`BOT_DEMO_USER_ID` 仍表示允许测试按钮和回声的用户。省略群 ID 时使用私聊。

部署前应实际确认：

1. 两个按钮都显示正确文案，点击后打印「演示已收到卡片按钮事件」。
2. 点击「按钮1」「按钮2」分别显示对应选择，原卡不再包含按钮。
3. 钉钉打印「钉钉已确认主动更新原卡」；企微打印「企微已确认卡片更新」。只有「演示按钮已处理」或「结果已交付点击回调」还不能证明平台更新成功。
4. 若钉钉只有收卡没有回调，查看新增的回调校验诊断；若企微出现 `42045`，检查结果卡链接和实际 `card_action`，不要将该次测试视为通过。

## 许可证

AGPL-3.0-only，详见 [LICENSE](./LICENSE)。
