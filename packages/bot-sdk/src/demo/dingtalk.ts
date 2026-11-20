#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { createAdapter, DingtalkApiError } from '../adapters/dingtalk/index.js'
import { createBot, type BotAdapter } from '../core/index.js'
import { required, runDemo } from './demo.js'

/** 等待用户私聊发送一次性口令，从该组织的机器人回调读取员工 ID。 */
async function lookupUserId(adapter: BotAdapter): Promise<void> {
  const bot = createBot({ adapters: [adapter] })
  const code = randomBytes(8).toString('hex')
  try {
    await bot.start()
    console.log(`请在五分钟内私聊测试机器人，只发送这一串口令：${code}`)
    const userId = await new Promise<string | undefined>((resolve) => {
      const timeout = setTimeout(() => resolve(undefined), 300_000)
      bot.onMessage(({ conversation, text }) => {
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
  cardTemplateId: lookup ? '' : required('DINGTALK_CARD_TEMPLATE_ID'),
  robotCode: process.env.DINGTALK_ROBOT_CODE,
  ...(lookup ? { onMessageDiagnostic: (message: string) => console.log(message) } : {}),
  ...(process.env.DINGTALK_DEMO_DEBUG === '1'
    ? {
        onDeliveryFailureDetail(message) {
          // 仅在本地模拟卡片中打印平台的单条拒投说明。JSON 转义可保留换行和控制字符的原貌。
          console.error('钉钉投递说明', JSON.stringify(message.slice(0, 500)))
        },
      }
    : {}),
})
if (lookup) await lookupUserId(adapter)
else
  await runDemo(adapter, {
    approveFirst: true,
    onStartupError(error) {
      if (!(error instanceof DingtalkApiError)) return false
      console.error(error.message)
      return true
    },
  })
