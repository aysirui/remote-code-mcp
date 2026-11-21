# @rcm/bot-sdk

面向 Node.js 22+ 的 TypeScript 机器人 SDK，为飞书、企业微信智能机器人和钉钉提供统一的私聊、群聊文字及交互卡片 API。平台连接、模板渲染和按钮协议由 adapter 处理；账号绑定、权限、审批和持久化由应用负责。

## 安装

包尚未发布到 npm，可在仓库运行 `pnpm --filter @rcm/bot-sdk pack`，再在项目中运行 `npm install /path/to/rcm-bot-sdk-0.1.0.tgz`。

## 创建与使用

```ts
import { createBot } from '@rcm/bot-sdk/core'
import { createAdapter } from '@rcm/bot-sdk/adapters/feishu'

const bot = createBot({
  adapter: createAdapter({ appId, appSecret }),
  onError: (error) => console.error(error.message),
})

bot.messages.onMessage(async (event) => {
  // 根据需要核验 event.actorId，再回复原私聊或群聊。
  await event.reply(`收到：${event.text}`)
})

bot.cards.onAction(async (event) => {
  // 业务必须核验点击者、卡片、有效期、重复操作和动作 ID。
  if (event.actorId !== allowedUserId || event.actionId !== 'confirm') return
  await event.update({ title: '已确认', body: '操作已完成', buttons: [] })
})

await bot.start()
await bot.messages.send(userId, '你好')
const ref = await bot.cards.send(userId, {
  title: '任务提醒',
  body: '请确认已收到。',
  buttons: [{ id: 'confirm', label: '确认', style: 'primary' }],
})
// 在需要退出时调用 await bot.stop()，不要在等待消息期间提前关闭。
```

`createBot` 自动装配文字和卡片实现，无需手动安装能力。每个 Bot 使用一个 adapter；同时连接三个平台时创建三个 Bot。默认 ID 是平台名，同平台多实例通过 adapter 的 `id` 区分。

## 私聊与群聊

```ts
await bot.messages.send({ userId }, '私聊文字')
const group = { type: 'group' as const, chatId }
await bot.messages.send(group, '群消息')
await bot.cards.send(group, { title: '群提醒', body: '请查看', buttons: [] })
```

调用时不需要重复传 `botId`。事件的 `conversation` 可直接作为发送目标；显式传入其他 Bot 的会话会被拒绝。`actorId` 始终表示实际发送者或点击者，群 ID 不能替代用户身份。平台仍要求机器人在相应可用范围、群内并具有权限。

飞书私聊使用 `open_id`，群使用 `chat_id`；企微使用 `userid` 或 `chatid`；钉钉使用 `staffId` 或 `openConversationId`。SDK 统一结构，不自动关联不同平台的用户身份。

## 平台配置集中在 adapter

普通 `cards.send(to, card)` 不接收平台字段。钉钉模板和企微通知链接在创建 adapter 时配置一次，更新原卡时继续使用发送时的配置。

```ts
import { createAdapter as dingtalk } from '@rcm/bot-sdk/adapters/dingtalk'
import { createAdapter as wecom } from '@rcm/bot-sdk/adapters/wecom'

const ding = createBot({
  adapter: dingtalk({
    clientId,
    clientSecret,
    corpId,
    robotCode,
    cards: {
      templateId,
      // 可省略映射以使用 SDK 默认模板约定，也可完整匹配自己的模板。
      titleVariable: 'heading',
      bodyVariable: 'description',
      buttonActionParam: 'action',
      buttonSlots: [
        {
          componentId: 'left',
          labelVariable: 'leftText',
          visibleVariable: 'leftVisible',
          actionIdVariable: 'leftAction',
        },
        {
          componentId: 'right',
          labelVariable: 'rightText',
          visibleVariable: 'rightVisible',
          actionIdVariable: 'rightAction',
        },
      ],
    },
  }),
})
const wx = createBot({
  adapter: wecom({
    botId,
    secret,
    cards: { textNoticeUrl: 'https://example.com/', updateScope: 'all' },
  }),
})
```

**模板变量不必采用 SDK 的默认名字。** 省略映射才要求模板符合默认约定；自定义映射则要求模板变量、组件及回传参数与配置一致。上例的回传参数 `action` 分别绑定 `leftAction`、`rightAction` 变量，不能填写同名字面字符串。按钮动作值来自每次发卡的 `buttons[].id`，模板不需要预先写死“批准”“拒绝”。SDK 不负责创建或发布钉钉后台模板。

企微无按钮通知卡必须有有效链接，因此 `textNoticeUrl` 是必要的接入配置；SDK 不替应用选择网站。`updateScope` 默认 `actor`，群共享状态可选择 `all`。飞书无需模板配置，可以通过 `messagePolicy` 自定义平台消息策略。

## 卡片与更新

通用 `Card` 包含 `title`、`body`、`buttons`。每个按钮有 `id`、`label`，可选 `style: 'primary' | 'secondary'`、`visible`。按数组顺序映射平台按钮，实际布局由平台或模板决定；`buttons: []` 表示无按钮卡。

从 `@rcm/bot-sdk/cards` 导出的 `defaultCard` 提供“按钮1”“按钮2”及同名通用动作，不包含审批逻辑。通过新对象定制，不要原地修改共享预置。

`bot.cards.update(ref, card)` 和 `event.update(card)` 使用同一套更新逻辑，优先主动更新，否则使用当前有效回调窗口。调用方无需调用 `deferCardUpdate` 或选择 `settle`。返回值：

| 结果          | 含义                                                      |
| ------------- | --------------------------------------------------------- |
| `updated`     | 平台已确认主动更新                                        |
| `accepted`    | 已将新卡交付按钮回调；最终平台回执错误通过 `onError` 报告 |
| `unavailable` | 当前平台不能主动更新且没有有效回调窗口                    |

SDK 不会假装所有平台都支持延迟更新，也不会自动补发结果消息。需要补发时，应用根据 `unavailable` 自行核验接收者并发消息。平台请求失败抛出异常，不按“不支持”吞掉。

`CardRef` 必须使用本 Bot 发送时返回的原始引用，不能复制或跨 Bot 使用。目前引用、模板配置和会话记录保存在本进程内，最多保存最近 10,000 张卡片的回调上下文，不提供重启后恢复。未知原卡无法使用 `event.update`，可按平台能力使用原生客户端处理。

文字和按钮都支持多个订阅者，返回取消订阅函数。按钮处理器按注册顺序执行；不同业务应通过卡片及动作自行分流，避免多个处理器同时修改同一张卡。回调更新窗口从平台事件到达起计算，长任务可能超时；SDK 不延长平台限制。

## 原生客户端

`bot.native` 返回 adapter 持有的同一个原生实例，并保留具体 TypeScript 类型：

| adapter | `bot.native`                       |
| ------- | ---------------------------------- |
| 飞书    | `createLarkChannel` 返回的 channel |
| 企微    | 官方 `WSClient`                    |
| 钉钉    | `dingtalk-stream` 的 `DWClient`    |

```ts
const bot = createBot({ adapter: wecom({ botId, secret }) })
await bot.start()
// 原生 Markdown 接口示例，接收并返回官方 SDK 类型。
await bot.native.sendMessage(chatId, {
  msgtype: 'markdown',
  markdown: { content: '**原生消息**' },
})
```

原生接口受上游 SDK 的能力和权限约束，例如钉钉 `DWClient` 是 Stream 客户端，并非完整 OpenAPI SDK。需要额外 REST 能力时可使用对应官方客户端；钉钉 adapter 同时公开其已认证的 `request(path, method, body)` 基础方法。原生调用自行处理平台字段、异常及业务授权；由 `bot.start/stop` 统一管理连接，不要重复创建连接或替换 SDK 的监听。

## 多机器人与扩展

```ts
import { BotManager } from '@rcm/bot-sdk/core'
const manager = new BotManager({ bots: [ding, wx], retryAfterMs: 30_000 })
// 一次注册即可接收所有已登记 Bot 的事件，无需业务遍历实例。
manager.messages.onMessage(async (event) => {
  await event.reply(`收到：${event.text}`)
})
manager.cards.onAction(async (event) => {
  // 先按 event.botId、actorId、cardId 和 actionId 核验业务权限。
  await event.update({ title: '处理完成', body: '已完成', buttons: [] })
})
await manager.start()
await manager.messages.send({ botId: 'dingtalk', userId }, '通知')
const ref = await manager.cards.send(
  { botId: 'wecom', type: 'group', chatId },
  {
    title: '群提醒',
    body: '请确认',
    buttons: [{ id: 'confirm', label: '确认' }],
  },
)
await manager.cards.update(ref, { title: '已完成', body: '结果', buttons: [] })
// 退出时 await manager.stop()
```

`manager.messages` 和 `manager.cards` 提供统一收发与订阅，事件保留原 Bot 的回复和更新上下文。管理器发送必须提供 `botId`，避免跨平台误投；更新从原始 `CardRef.botId` 定位 Bot，不会广播。未知 Bot 报错。

订阅返回的取消函数解除该处理器在全部 Bot 上的绑定，不影响其他订阅者。订阅跨 `stop/start` 保留，重启与首连重试不重复绑定；停止期间由 Bot 阻止事件交付。`manager.get(id)` 仍用于查询单个 Bot 的状态或访问其原生客户端。

管理器独立启动及重试每个 Bot，已连接实例可继续工作。单个 `bot.start()` 连接失败直接抛出错误。`bot.isConnected()` 查询当前启动状态。

`core` 定义统一 API、生命周期和会话模型，adapter 处理平台认证、消息转换和回调协议。底层 `Capability`、`bot.install`、`manager.install` 和 `/text`、`/cards` 能力接口保留给第三方扩展；普通业务使用 `bot.messages` 和 `bot.cards`。不要同时通过底层 `CardCapability.onAction` 和 `bot.cards` 接管同一个事件路由。

自定义 adapter 实现 `BotAdapter`，可通过 `native` 提供原生客户端，并通过 `textAdapter`、`cardAdapter` 扩展键提供文字和卡片工厂。缺少能力时发送会抛出 `UnsupportedCapabilityError`。原生客户端为可选字段，自定义 adapter 未提供时 `bot.native` 为 `undefined`。

## 本次 API 调整

原先 `bot.install(new TextCapability())` 改为 `bot.messages`，卡片同理。将 `cards.send` 第三个平台参数和 `withOptions` 配置迁移到对应 adapter 的 `cards` 中；将 `deferCardUpdate` 加 `settle` 改为 `event.update(card)` 或 `bot.cards.update(ref, card)`。自动结果补发由应用明确执行，不再混入常规卡片更新流程。特殊的多模板投放可以使用底层卡片扩展接口或原生平台接口，共用当前连接。

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
- **企业微信**：创建支持长连接的智能机器人，确保测试成员在可用范围内。适配器接收 `{ id, botId, secret, cards? }`，其中 `botId` 是企微凭证中的机器人 ID。无按钮的通知卡（包括点击后替换的卡片）必须在 adapter 的 `cards` 中配置 `textNoticeUrl`，生成 `card_action.type = 1` 及有效链接。实际智能机器人接口会以 `42045` 拒绝 `type = 0`，不能仅依赖上游 SDK 的类型声明。正文中最多六条形如「标签：内容」的行用原生字段展示。不要同时运行共享同一凭证的多个实例。
- **钉钉**：开启企业内部应用机器人和 Stream，申请使用场景对应的私聊、群聊消息及卡片接口权限，并把机器人添加到目标群。适配器接收 `{ id, clientId, clientSecret, corpId, robotCode? }`，未配置 `robotCode` 时使用 `clientId`。在 adapter 的 `cards` 中配置 `templateId`。

### 钉钉模板

在钉钉卡片平台创建并发布应用可用的互动模板，配置 Stream 回传。绑定纯文本标题 `title` 和正文 `body`。默认模板提供两个按钮槽：

| 按钮组件 ID | 标签变量      | 显示条件               | 可选服务端回传参数           |
| ----------- | ------------- | ---------------------- | ---------------------------- |
| `button1`   | `firstLabel`  | `showFirst` 为 `true`  | `botSdkAction` 取 `firstId`  |
| `button2`   | `secondLabel` | `showSecond` 为 `true` | `botSdkAction` 取 `secondId` |

数组中的第一个按钮对应第一个模板槽，模板决定槽位的实际位置。隐藏某个按钮时，后面的按钮仍使用各自的槽位。SDK 仅按数组顺序映射通用槽位，不决定业务动作。

自定义模板可在 adapter 的 `cards` 配置中使用 `titleVariable` 和 `bodyVariable` 覆盖标题与正文变量，使用 `buttonSlots` 指定每个槽的 `componentId`、`labelVariable`、`visibleVariable` 和 `actionIdVariable`。`componentId` 是模板编辑器中的按钮组件 ID；默认依次为 `button1`、`button2`，不是显示文案或动作变量名。数组长度决定该模板可接收多少个按钮。如果模板使用其他回传参数名，通过 `buttonActionParam` 指定，默认 `botSdkAction`。

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

`src/demo/demo.ts` 中的 `cards.onAction` 是可运行的通用回调示例：核验点击者、机器人、卡片和有效期，读取 `actionId`，然后通过 `event.update` 替换原卡。每次启动测试一个按钮，再重启测试另一个按钮；首次选择会保留，重复点击不应改变结果。

演示中的事件处理顺序如下；`select` 是绑定当前测试用户、机器人、卡片和有效期的 `demoSelection` 返回值，更新目标由事件保存：

```ts
cards.onAction(async (event) => {
  const choice = select(event)
  if (!choice) return
  const body = choice === 'expired' ? '卡片已过期' : `已选择 ${choice}`
  // SDK 选择该平台当前可用的更新方式，业务只传入内容。
  const settlement = await event.update({
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
