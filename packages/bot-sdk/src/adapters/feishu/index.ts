import { cardAdapter } from '../../core/capabilities/cards/contracts.js'
import { textAdapter } from '../../core/capabilities/text/contracts.js'
import { createCardAdapter } from './cards.js'
import { FeishuConnection, type FeishuOptions } from './connection.js'
import { createTextAdapter } from './text.js'

export type { FeishuOptions } from './connection.js'

/** 配置飞书机器人连接。调用 bot.start() 时才建立长连接。 */
export function createAdapter(options: FeishuOptions) {
  const connection = new FeishuConnection(options)
  return Object.assign(connection, {
    [textAdapter]: () => createTextAdapter(connection),
    [cardAdapter]: () => createCardAdapter(connection),
  })
}
