#!/usr/bin/env node
import { createAdapter } from '../adapters/wecom/index.js'
import { required, runDemo } from './demo.js'

await runDemo(
  createAdapter({
    id: 'wecom-demo',
    botId: required('WECOM_BOT_ID'),
    secret: required('WECOM_SECRET'),
    textNoticeUrl: 'https://github.com/aysirui/remote-code-mcp',
    onDiagnostic: (message) => console.log(message),
  }),
  {
    details: [
      '测试卡片，不会执行文件或命令操作。五分钟后失效。',
      '设备：本地测试设备',
      '工作区：模拟工作区',
      '操作：执行命令',
      '完整命令：node --version',
      '工作目录：工作区根目录',
      '授权范围：仅本次',
    ].join('\n'),
  },
)
