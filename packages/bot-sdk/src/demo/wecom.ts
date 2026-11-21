#!/usr/bin/env node
import { createAdapter } from '../adapters/wecom/index.js'
import { required, runDemo } from './demo.js'

const adapter = createAdapter({
  id: 'wecom-demo',
  botId: required('WECOM_BOT_ID'),
  secret: required('WECOM_SECRET'),
  onDiagnostic: (message) => console.log(message),
})
await runDemo(adapter, {
  cardOptions: { textNoticeUrl: 'https://github.com/aysirui/remote-code-mcp' },
  details: [
    '通用测试卡片，五分钟后失效。',
    '设备：本地测试设备',
    '工作区：模拟工作区',
    '说明：点击任意按钮查看选择结果',
  ].join('\n'),
})
