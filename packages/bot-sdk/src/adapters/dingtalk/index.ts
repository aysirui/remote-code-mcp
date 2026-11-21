import { cardAdapter } from '../../core/capabilities/cards/contracts.js'
import { textAdapter } from '../../core/capabilities/text/contracts.js'
import { createCardAdapter } from './cards.js'
import { DingtalkConnection, type DingtalkOptions } from './connection.js'
import { createTextAdapter } from './text.js'

export type { DingtalkOptions } from './connection.js'
export { DingtalkApiError } from './connection.js'
export type { DingtalkButtonSlot, DingtalkCardOptions } from './cards.js'

/** 配置钉钉机器人连接。调用 bot.start() 时才建立长连接。 */
export function createAdapter(options: DingtalkOptions) {
  const connection = new DingtalkConnection(options)
  return Object.assign(connection, {
    [textAdapter]: () => createTextAdapter(connection, options.onDiagnostic),
    [cardAdapter]: () => createCardAdapter(connection, options.onDiagnostic),
  })
}
