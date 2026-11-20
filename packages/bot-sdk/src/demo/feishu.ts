#!/usr/bin/env node
import { createAdapter } from '../adapters/feishu/index.js'
import { required, runDemo } from './demo.js'

const adapter = createAdapter({
  id: 'feishu-demo',
  appId: required('FEISHU_APP_ID'),
  appSecret: required('FEISHU_APP_SECRET'),
})
await runDemo(adapter)
