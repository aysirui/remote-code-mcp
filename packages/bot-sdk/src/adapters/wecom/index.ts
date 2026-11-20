import { cardAdapter } from '../../core/capabilities/cards/contracts.js'
import { textAdapter } from '../../core/capabilities/text/contracts.js'
import { createCardAdapter } from './cards.js'
import { WecomConnection, type WecomOptions } from './connection.js'
import { createTextAdapter } from './text.js'

export type { WecomOptions } from './connection.js'
export type { WecomCardOptions } from './cards.js'

/** 配置企业微信机器人连接。调用 bot.start() 时才建立长连接。 */
export function createAdapter(options: WecomOptions) {
  const connection = new WecomConnection(options)
  return Object.assign(connection, {
    [textAdapter]: () => createTextAdapter(connection),
    [cardAdapter]: () => createCardAdapter(connection),
  })
}
