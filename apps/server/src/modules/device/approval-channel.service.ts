import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { and, eq, gt, isNull, ne } from 'drizzle-orm'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Bot, BotAdapter, CardRef } from '@rcm/bot-sdk/core'
import type { ApprovalNotice } from '@rcm/protocol'
import { env } from '../../config/env'
import { hash } from '../../common/security'
import {
  approvalChannelChallenges as challenges,
  approvalChannelBindings as bindings,
  users,
} from '../../infrastructure/database/schema'
import { Store } from '../../infrastructure/database/store'

/** 绑定代次与收件人，关联单次 RPC，避免重新绑定后使用旧卡片。 */
export type ApprovalRecipient = typeof bindings.$inferSelect

/** 已投递卡片的短期路由，仅在内存中保留已发摘要以更新状态。 */
interface Delivery {
  recipient: ApprovalRecipient
  /** 发布时的原卡正文，不含 Runtime 本机专用详情。 */
  body: string
  expiresAt: number
  answer: (approved: boolean) => Promise<boolean>
}

/** 支持的部署级渠道标识。 */
export type ApprovalChannel = ApprovalRecipient['channel']

/** 单个已配置渠道的连接及生命周期。 */
interface ChannelConnection {
  appId: string
  botLink?: string
  create: () => Promise<BotAdapter>
  bot?: Bot
  startup?: Promise<void>
  retry?: NodeJS.Timeout
}

/** 只创建配置齐全的渠道；各机器人连接独立失败和重试。 */
function configuredChannels() {
  const channels = new Map<ApprovalChannel, ChannelConnection>()
  const feishu = env.feishuApproval
  const wecom = env.wecomApproval
  const dingtalk = env.dingtalkApproval
  if (feishu)
    channels.set('feishu', {
      ...feishu,
      create: async () =>
        (await import('@rcm/bot-sdk/adapters/feishu')).createAdapter({ ...feishu, id: 'feishu' }),
    })
  if (wecom)
    channels.set('wecom', {
      ...wecom,
      appId: wecom.botId,
      create: async () =>
        (await import('@rcm/bot-sdk/adapters/wecom')).createAdapter({ ...wecom, id: 'wecom' }),
    })
  if (dingtalk)
    channels.set('dingtalk', {
      ...dingtalk,
      appId: hash(JSON.stringify([dingtalk.corpId, dingtalk.clientId, dingtalk.robotCode])),
      create: async () =>
        (await import('@rcm/bot-sdk/adapters/dingtalk')).createAdapter({
          ...dingtalk,
          id: 'dingtalk',
        }),
    })
  return channels
}

/** 统一的审批结果；状态卡不含原始摘要。 */
const messages = {
  approved: '已批准（不代表执行成功）',
  denied: '已拒绝',
  expired: '已过期',
  cancelled: '审批已失效',
}

/** Server 进程内的通知网关，统一处理多条平台连接、双向绑定及审批卡片。 */
@Injectable()
export class ApprovalChannelService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ApprovalChannelService.name)
  private readonly channels = configuredChannels()
  private readonly deliveries = new Map<string, Delivery>()
  private stopping = false

  constructor(private readonly store: Store) {}

  /** 异步启动，不让任一渠道故障阻断 MCP 服务。 */
  onApplicationBootstrap() {
    for (const [channel, connection] of this.channels)
      connection.startup = this.connect(channel, connection)
  }

  /** 停止重试、等待启动完成并关闭机器人连接。 */
  async onApplicationShutdown() {
    this.stopping = true
    await Promise.allSettled(
      [...this.channels.values()].map(async (connection) => {
        clearTimeout(connection.retry)
        await connection.startup
        await connection.bot?.stop()
      }),
    )
  }

  /** 连接失败只记录固定提示；使用动态导入兼容 CommonJS Server 与 ESM SDK。 */
  private async connect(channel: ApprovalChannel, config: ChannelConnection) {
    if (this.stopping) return
    try {
      const { createBot } = await import('@rcm/bot-sdk/core')
      const bot = createBot({
        adapters: [await config.create()],
        onError: () => this.logger.warn(`${channel} 连接或事件处理失败`),
      })
      bot.onMessage(async ({ conversation, text }) => {
        const code = /^绑定\s+([a-f0-9]{32})$/.exec(text.trim())?.[1]
        if (!code) return
        const confirmation = await this.receiveCode(
          channel,
          config.appId,
          code,
          conversation.userId,
        )
        if (confirmation)
          await bot.sendText(
            conversation,
            `请在发起绑定的 RCM 控制台输入确认码：${confirmation}。请勿把确认码发给他人。`,
          )
      })
      bot.onAction(async ({ cardId, actorId, actionId }) => {
        const key = channel + ':' + cardId
        const delivery = this.deliveries.get(key)
        if (!delivery || delivery.expiresAt <= Date.now()) return
        if (actorId !== delivery.recipient.platformUserId) return
        if (actionId !== 'approve' && actionId !== 'deny') return
        const forwarded = await delivery.answer(actionId === 'approve')
        if (!bot.capabilities(channel).proactiveCardUpdate)
          return {
            card: {
              title: 'RCM 操作审批',
              body: `状态：${forwarded ? '已提交决定，请以结果通知为准。' : '审批已处理或已失效。'}\n\n${delivery.body}`,
              buttons: [],
            },
          }
      })
      await bot.start()
      config.bot = bot
    } catch {
      this.logger.warn(`${channel} 审批机器人未能启动`)
      if (!this.stopping) {
        config.retry = setTimeout(() => {
          config.startup = this.connect(channel, config)
        }, 30_000)
        config.retry.unref()
      }
    }
  }

  /** 只列出配置齐全的渠道，不暴露平台身份。 */
  async status(userId: string) {
    if (!this.channels.size) return []
    const rows = await this.bindings(userId)
    return [...this.channels.keys()].map((channel) => {
      const binding = rows.find((row) => row.channel === channel)
      return { channel, bound: !!binding, enabled: binding?.enabled ?? false }
    })
  }

  /** 为登录用户生成短期一次性绑定码；新挑战替换旧挑战。 */
  async begin(userId: string, channel: ApprovalChannel) {
    const config = this.channels.get(channel)
    if (!config?.bot) throw new ServiceUnavailableException('此渠道机器人暂不可用')
    if ((await this.bindings(userId)).some((row) => row.channel === channel))
      throw new ConflictException('请先解除此渠道绑定')
    const code = randomBytes(16).toString('hex')
    const expiresAt = new Date(Date.now() + 5 * 60_000)
    const row = {
      userId,
      channel,
      appId: config.appId,
      codeHash: hash(code),
      expiresAt,
      platformUserId: null,
      confirmationHash: null,
    }
    await this.store.db.insert(challenges).values(row).onDuplicateKeyUpdate({ set: row })
    return {
      botLink: config.botLink,
      message: `绑定 ${code}`,
      expiresAt: expiresAt.toISOString(),
    }
  }

  /** 从已验证的机器人私聊取得候选身份；原码只消费一次，确认码仅回复候选者。 */
  private async receiveCode(
    channel: ApprovalChannel,
    appId: string,
    code: string,
    platformUserId: string,
  ) {
    if (
      !platformUserId ||
      platformUserId.length > 128 ||
      (channel === 'feishu' && !platformUserId.startsWith('ou_'))
    )
      return
    const confirmation = randomBytes(16).toString('hex')
    const [result] = await this.store.db
      .update(challenges)
      .set({ platformUserId, confirmationHash: hash(confirmation) })
      .where(
        and(
          eq(challenges.channel, channel),
          eq(challenges.appId, appId),
          eq(challenges.codeHash, hash(code)),
          isNull(challenges.confirmationHash),
          gt(challenges.expiresAt, new Date()),
        ),
      )
    if (result.affectedRows === 1) return confirmation
  }

  /** 仅允许发起账号用机器人回传的确认码完成绑定，事务内消费挑战。 */
  async confirm(userId: string, channel: ApprovalChannel, confirmation: string) {
    const appId = this.channels.get(channel)?.appId
    if (!appId) throw new ServiceUnavailableException('此审批渠道未启用')
    try {
      await this.store.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(challenges)
          .where(
            and(
              eq(challenges.userId, userId),
              eq(challenges.channel, channel),
              eq(challenges.appId, appId),
              eq(challenges.confirmationHash, hash(confirmation)),
              gt(challenges.expiresAt, new Date()),
            ),
          )
          .for('update')
        if (!row?.platformUserId) throw new ConflictException('确认码无效或已过期，请重新绑定')
        await tx
          .delete(bindings)
          .where(
            and(
              eq(bindings.userId, userId),
              eq(bindings.channel, channel),
              ne(bindings.appId, appId),
            ),
          )
        await tx.insert(bindings).values({
          userId,
          channel,
          appId,
          platformUserId: row.platformUserId,
          revision: randomUUID(),
        })
        await tx
          .delete(challenges)
          .where(and(eq(challenges.userId, userId), eq(challenges.channel, channel)))
      })
    } catch (error) {
      const cause = error instanceof Error ? (error.cause ?? error) : error
      if (typeof cause === 'object' && cause && 'code' in cause && cause.code === 'ER_DUP_ENTRY')
        throw new ConflictException('该渠道身份或 RCM 账号已绑定')
      throw error
    }
  }

  /** 撤销绑定并取消未完成挑战；旧卡片不再有权提交决定。 */
  async unbind(userId: string, channel: ApprovalChannel) {
    if (!this.channels.has(channel)) throw new ServiceUnavailableException('此审批渠道未启用')
    await this.store.db.transaction(async (tx) => {
      await tx
        .delete(challenges)
        .where(and(eq(challenges.userId, userId), eq(challenges.channel, channel)))
      await tx
        .delete(bindings)
        .where(and(eq(bindings.userId, userId), eq(bindings.channel, channel)))
    })
  }

  /** 开关通知但保留绑定；停用后重新启用也不能恢复旧卡权限。 */
  async setEnabled(userId: string, channel: ApprovalChannel, enabled: boolean) {
    const appId = this.channels.get(channel)?.appId
    if (!appId) throw new ServiceUnavailableException('此审批渠道未启用')
    const [result] = await this.store.db
      .update(bindings)
      .set({ enabled, revision: randomUUID() })
      .where(
        and(eq(bindings.userId, userId), eq(bindings.channel, channel), eq(bindings.appId, appId)),
      )
    if (!result.affectedRows) throw new ConflictException('请先完成渠道绑定')
  }

  /** 只读取当前部署已配置、账号仍活跃的绑定；未配置时不查表。 */
  private async bindings(userId: string) {
    if (!this.channels.size) return []
    const rows = await this.store.db
      .select({ binding: bindings })
      .from(bindings)
      .innerJoin(users, and(eq(users.id, bindings.userId), eq(users.status, 'active')))
      .where(eq(bindings.userId, userId))
    return rows
      .map(({ binding }) => binding)
      .filter((binding) => this.channels.get(binding.channel)?.appId === binding.appId)
  }

  /** 返回已启用且机器人已启动的收件人。 */
  async recipients(userId: string) {
    if (![...this.channels.values()].some((channel) => channel.bot)) return []
    return (await this.bindings(userId)).filter(
      (binding) => binding.enabled && this.channels.get(binding.channel)?.bot,
    )
  }

  /** 判断本次发卡绑定是否仍启用且未更换。 */
  async isCurrent(recipient: ApprovalRecipient): Promise<boolean> {
    return (await this.bindings(recipient.userId)).some(
      (binding) =>
        binding.channel === recipient.channel &&
        binding.enabled &&
        binding.revision === recipient.revision,
    )
  }

  /** 私发审批卡；设备显示名由 Server 提供，失败不影响 Runtime 本地审批。 */
  async deliver(
    recipient: ApprovalRecipient,
    notice: ApprovalNotice,
    deviceName: string,
    answer: Delivery['answer'],
  ) {
    const bot = this.channels.get(recipient.channel)?.bot
    if (!bot || notice.expiresAt <= Date.now() || !(await this.isCurrent(recipient))) return
    const body = `设备：${deviceName.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim() || '未命名设备'}\n${notice.summary}`
    const ref = await bot.sendCard(
      { botId: recipient.channel, userId: recipient.platformUserId },
      {
        title: 'RCM 操作审批',
        body,
        buttons: [
          { id: 'approve', label: '批准' },
          { id: 'deny', label: '拒绝' },
        ],
      },
    )
    this.deliveries.set(recipient.channel + ':' + ref.cardId, {
      recipient,
      body,
      expiresAt: notice.expiresAt,
      answer,
    })
    return ref
  }

  /** 清除决策路由并保留原详情；不支持主动更新时附原详情另发结果。 */
  async close(ref: CardRef, status: keyof typeof messages) {
    const key = ref.botId + ':' + ref.cardId
    const delivery = this.deliveries.get(key)
    this.deliveries.delete(key)
    const bot = this.channels.get(ref.botId as ApprovalChannel)?.bot
    if (!bot || !delivery) return
    const card = {
      title: 'RCM 操作审批',
      body: `状态：${messages[status]}\n\n${delivery.body}`,
      buttons: [],
    }
    if (bot.capabilities(ref.botId).proactiveCardUpdate) await bot.updateCard(ref, card)
    else if (await this.isCurrent(delivery.recipient))
      await bot.sendText(ref, card.title + '：' + card.body)
  }
}
