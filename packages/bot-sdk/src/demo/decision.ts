/** 模拟审批卡片的决定；不执行任何实际操作。 */
type Decision = 'approved' | 'rejected' | 'expired'

/** 创建单张模拟审批的状态机；仅接受指定用户在指定机器人卡片上的动作。 */
export function demoDecision(botId: string, userId: string, cardId: string, expiresAt: number) {
  let decision: Decision | undefined
  return (
    event: { botId: string; actorId: string; cardId: string; actionId: string },
    now = Date.now(),
  ) => {
    if (event.botId !== botId || event.actorId !== userId || event.cardId !== cardId) return
    if (event.actionId !== 'approve' && event.actionId !== 'reject') return
    decision ??=
      now >= expiresAt ? 'expired' : event.actionId === 'approve' ? 'approved' : 'rejected'
    return decision
  }
}
