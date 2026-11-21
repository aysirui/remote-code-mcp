#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import {
  createAdapter,
  DingtalkApiError,
  type DingtalkCardOptions,
} from '../adapters/dingtalk/index.js'
import { createBot, type BotAdapter } from '../core/index.js'
import { TextCapability } from '../core/capabilities/text/index.js'
import { required, runDemo } from './demo.js'

/** 等待用户私聊发送一次性口令，从该组织的机器人回调读取员工 ID。 */
async function lookupUserId(adapter: BotAdapter): Promise<void> {
  const bot = createBot({ adapter })
  const textCapability = bot.install(new TextCapability())
  const code = randomBytes(8).toString('hex')
  try {
    await bot.start()
    console.log(`请在五分钟内私聊测试机器人，只发送这一串口令：${code}`)
    const userId = await new Promise<string | undefined>((resolve) => {
      const timeout = setTimeout(() => resolve(undefined), 300_000)
      textCapability.onMessage(({ conversation, text }) => {
        // 此演示查询的是私聊用户 ID；群聊回调仍由 SDK 正常交付，演示自行过滤。
        if (conversation.type === 'group') return
        // 兼容用户沿用旧版提示输入「查询ID」前缀，只接受本次随机口令。
        const submitted = text
          .trim()
          .replace(/^查询\s*id\s*[:：]?\s*/iu, '')
          .toLowerCase()
        if (submitted !== code) {
          console.log('已收到私聊文本，但口令不一致。请复制本次终端显示的口令。')
          return
        }
        clearTimeout(timeout)
        resolve(conversation.userId)
      })
    })
    if (userId) {
      console.log(`当前组织的 BOT_DEMO_USER_ID：${userId}`)
      if (process.env.BOT_DEMO_USER_ID)
        console.log(`与当前环境变量一致：${process.env.BOT_DEMO_USER_ID === userId ? '是' : '否'}`)
    } else {
      process.exitCode = 1
      console.error('未收到匹配的私聊消息，请确认组织、机器人和 Stream 连接。')
    }
  } finally {
    await bot.stop()
  }
}

const lookup = process.argv.includes('--lookup-user-id')
const adapter = createAdapter({
  id: 'dingtalk-demo',
  clientId: required('DINGTALK_CLIENT_ID'),
  clientSecret: required('DINGTALK_CLIENT_SECRET'),
  corpId: required('DINGTALK_CORP_ID'),
  robotCode: process.env.DINGTALK_ROBOT_CODE,
  onDiagnostic: (message) => console.log(message),
})
if (lookup) await lookupUserId(adapter)
else {
  // 模板组件 ID 可自定义；变量名沿用通用模板，避免把审批业务写入 SDK 演示。
  const componentIds = (process.env.DINGTALK_DEMO_BUTTON_IDS ?? 'button1,button2')
    .split(',')
    .map((id) => id.trim())
  if (componentIds.length !== 2 || componentIds.some((id) => !id))
    throw new Error('DINGTALK_DEMO_BUTTON_IDS 需要两个逗号分隔的模板组件 ID')
  await runDemo(adapter, {
    cardOptions: {
      templateId: required('DINGTALK_CARD_TEMPLATE_ID'),
      buttonSlots: [
        {
          componentId: componentIds[0],
          labelVariable: 'firstLabel',
          visibleVariable: 'showFirst',
          actionIdVariable: 'firstId',
        },
        {
          componentId: componentIds[1],
          labelVariable: 'secondLabel',
          visibleVariable: 'showSecond',
          actionIdVariable: 'secondId',
        },
      ],
      onDeliveryFailureDetail:
        process.env.DINGTALK_DEMO_DEBUG === '1'
          ? // 仅在本地模拟卡片中打印平台单条拒投说明。
            (message) => console.error('钉钉投递说明', JSON.stringify(message.slice(0, 500)))
          : undefined,
    } satisfies DingtalkCardOptions,
    onStartupError(error) {
      if (!(error instanceof DingtalkApiError)) return false
      console.error(error.message)
      return true
    },
  })
}
