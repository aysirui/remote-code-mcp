/** 通用演示的按钮选择；不表示批准或拒绝任何业务操作。 */
type Selection = 'button1' | 'button2' | 'expired'

/** 创建演示选择处理器；仅接受指定用户对原卡的首次有效点击，截止后返回过期。 */
export function demoSelection(botId: string, userId: string, cardId: string, expiresAt: number) {
  let selection: Selection | undefined
  return (
    event: { botId: string; actorId: string; cardId: string; actionId: string },
    now = Date.now(),
  ) => {
    if (event.botId !== botId || event.actorId !== userId || event.cardId !== cardId) return
    if (event.actionId !== 'button1' && event.actionId !== 'button2') return
    selection ??= now >= expiresAt ? 'expired' : event.actionId
    return selection
  }
}
