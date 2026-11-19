#!/usr/bin/env node
import { createAdapter } from '../adapters/dingtalk/index.js'
import { required, runDemo } from './demo.js'

await runDemo(
  createAdapter({
    id: 'dingtalk-demo',
    clientId: required('DINGTALK_CLIENT_ID'),
    clientSecret: required('DINGTALK_CLIENT_SECRET'),
    corpId: required('DINGTALK_CORP_ID'),
    cardTemplateId: required('DINGTALK_CARD_TEMPLATE_ID'),
    robotCode: process.env.DINGTALK_ROBOT_CODE,
  }),
)
