#!/usr/bin/env node
import { createAdapter } from '../adapters/wecom/index.js'
import { required, runDemo } from './demo.js'

await runDemo(
  createAdapter({
    id: 'wecom-demo',
    botId: required('WECOM_BOT_ID'),
    secret: required('WECOM_SECRET'),
  }),
)
