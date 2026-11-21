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
import type { ActionEvent, CardOptions, CardClient, CardRef } from '@rcm/bot-sdk/cards'
import type { Bot, BotAdapter, BotManager } from '@rcm/bot-sdk/core'
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
  /** 同一渠道内关联审批卡和结算通知的展示编号。 */
  reference: string
  expiresAt: number
  answer: (approved: boolean) => Promise<boolean>
}

/** 支持的部署级渠道标识。 */
export type ApprovalChannel = ApprovalRecipient['channel']

/** 已配置渠道的应用标识、分享链接和卡片选项。 */
interface ChannelConfig {
  /** 当前应用的身份，用于区分不同应用的绑定。 */
  appId: string
  /** 供用户打开机器人私聊的分享链接。 */
  botLink?: string
  /** 该渠道的审批卡片选项。 */
  cardOptions?: CardOptions
}

/** 原卡结果标题；审批通过只表示批准了请求。 */
const messages = {
  approved: '审批已通过',
  denied: '审批已拒绝',
  expired: '审批已过期',
  cancelled: '审批已失效',
}

/** Runtime 返回的审批结论。 */
type ApprovalStatus = keyof typeof messages

/** Server 进程内的通知网关，统一处理多条平台连接、双向绑定及审批卡片。 */
@Injectable()
export class ApprovalChannelService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ApprovalChannelService.name)
  private readonly channels = new Map<ApprovalChannel, ChannelConfig>()
  private readonly deliveries = new Map<string, Delivery>()
  private stopping = false
  private startup?: Promise<void>
  private manager?: BotManager
  private cards: ReadonlyMap<string, CardClient> = new Map()

  constructor(private readonly store: Store) {}

  /** 按渠道读取配置并创建机器人，连接失败由管理器独立重试。 */
  onApplicationBootstrap() {
    const { feishuApproval: feishu, wecomApproval: wecom, dingtalkApproval: dingtalk } = env
    if (!feishu && !wecom && !dingtalk) return

    const core = import('@rcm/bot-sdk/core')
    const pendingBots: Promise<Bot | undefined>[] = []

    if (feishu) {
      const { appId, appSecret, botLink } = feishu
      pendingBots.push(
        this.registerChannel(core, 'feishu', { appId, botLink }, async () => {
          const { createAdapter } = await import('@rcm/bot-sdk/adapters/feishu')
          return createAdapter({ id: 'feishu', appId, appSecret })
        }),
      )
    }

    if (wecom) {
      const { botId, secret, botLink } = wecom
      pendingBots.push(
        this.registerChannel(
          core,
          'wecom',
          {
            appId: botId,
            botLink,
            cardOptions: { textNoticeUrl: env.websiteUrl },
          },
          async () => {
            const { createAdapter } = await import('@rcm/bot-sdk/adapters/wecom')
            return createAdapter({ id: 'wecom', botId, secret })
          },
        ),
      )
    }

    if (dingtalk) {
      const { clientId, clientSecret, corpId, robotCode, cardTemplateId, botLink } = dingtalk
      pendingBots.push(
        this.registerChannel(
          core,
          'dingtalk',
          {
            appId: hash(JSON.stringify([corpId, clientId, robotCode])),
            botLink,
            cardOptions: {
              templateId: cardTemplateId,
              // 与已发布模板的 Label 变量及 reject、agree 组件保持一致，业务动作由调用方提供。
              buttonSlots: [
                {
                  componentId: 'reject',
                  labelVariable: 'firstLabel',
                  visibleVariable: 'showFirst',
                  actionIdVariable: 'firstId',
                },
                {
                  componentId: 'agree',
                  labelVariable: 'secondLabel',
                  visibleVariable: 'showSecond',
                  actionIdVariable: 'secondId',
                },
              ],
            },
          },
          async () => {
            const { createAdapter } = await import('@rcm/bot-sdk/adapters/dingtalk')
            return createAdapter({
              id: 'dingtalk',
              clientId,
              clientSecret,
              corpId,
              robotCode,
              // 卡片适配器只提供字段名和校验结果，供排查真实模板及回调问题。
              onDiagnostic: (message) => this.logger.debug(`dingtalk：${message}`),
            })
          },
        ),
      )
    }

    this.startup = this.startBots(core, pendingBots)
  }

  /** 等待装配完成，统一停止机器人、重试和能力监听。 */
  async onApplicationShutdown() {
    this.stopping = true
    await this.startup
    await this.manager?.stop()
  }

  /** 先登记渠道供绑定接口查询。加载失败时记录渠道并返回 undefined。 */
  private async registerChannel(
    core: Promise<typeof import('@rcm/bot-sdk/core')>,
    channel: ApprovalChannel,
    config: ChannelConfig,
    loadAdapter: () => Promise<BotAdapter>,
  ): Promise<Bot | undefined> {
    this.channels.set(channel, config)
    try {
      const [{ createBot }, adapter] = await Promise.all([core, loadAdapter()])
      return createBot({
        adapter,
        onError: (error) => this.logger.warn(`${channel}：${error.message}`),
      })
    } catch {
      this.logger.warn(`${channel} 审批机器人配置未能加载`)
      return undefined
    }
  }

  /** 为已创建的机器人安装通用审批能力，随后统一启停。 */
  private async startBots(
    core: Promise<typeof import('@rcm/bot-sdk/core')>,
    pendingBots: readonly Promise<Bot | undefined>[],
  ) {
    try {
      const [{ BotManager }, { TextCapability }, { CardCapability }, candidates] =
        await Promise.all([
          core,
          import('@rcm/bot-sdk/text'),
          import('@rcm/bot-sdk/cards'),
          Promise.all(pendingBots),
        ])
      const bots = candidates.filter((bot) => bot !== undefined)
      if (this.stopping || !bots.length) return

      const manager = new BotManager({
        bots,
        retryAfterMs: 30_000,
        onConnectionState: (botId, connected) => {
          if (connected) this.logger.log(`${botId} 审批机器人已连接`)
          else this.logger.warn(`${botId} 审批机器人未能启动，将重试`)
        },
      })
      const textsByBot = manager.install(() => {
        const texts = new TextCapability()
        texts.onMessage(async ({ conversation, text }) => {
          // SDK 支持群消息；RCM 账号绑定只允许私聊，防止群内暴露绑定确认码。
          if (conversation.type === 'group') return
          const channel = conversation.botId as ApprovalChannel
          const config = this.channels.get(channel)
          const code = /^绑定\s+([a-f0-9]{32})$/.exec(text.trim())?.[1]
          if (!config || !code) return
          const confirmation = await this.receiveCode(
            channel,
            config.appId,
            code,
            conversation.userId,
          )
          if (confirmation)
            await texts.send(
              conversation,
              `请在发起绑定的 RCM 控制台输入确认码：${confirmation}。请勿把确认码发给他人。`,
            )
        })
        return texts
      })
      this.cards = manager.install((bot) => {
        // 结算文本使用同一个机器人的文本能力。
        const texts = textsByBot.get(bot.id)!
        const cards = new CardCapability({
          sendText: (to, text) => texts.send(to, text),
        })
        cards.onAction((event) => this.handleAction(event))
        return cards
      })
      this.manager = manager
      await manager.start()
    } catch {
      this.logger.warn('审批机器人网关未能启动')
    }
  }

  /** 校验点击者与动作后转发决定；通过 SDK 保留可用的回调更新窗口。 */
  private async handleAction({
    botId: channel,
    cardId,
    actorId,
    actionId,
    deferCardUpdate,
    conversation,
  }: ActionEvent): Promise<void> {
    // 审批渠道使用私发原卡；SDK 只提供会话上下文，审批是否允许群聊由本业务明确决定。
    if (conversation?.type === 'group') return
    this.logger.debug(`${channel} 收到审批按钮事件`)
    const delivery = this.deliveries.get(channel + ':' + cardId)
    if (!delivery || delivery.expiresAt <= Date.now()) {
      this.logger.debug(`${channel} 审批卡片已失效或不在当前进程`)
      return
    }
    if (
      actorId !== delivery.recipient.platformUserId ||
      (actionId !== 'approve' && actionId !== 'deny')
    ) {
      this.logger.debug(`${channel} 审批按钮身份或操作校验失败`)
      return
    }
    const cancelCardUpdate = deferCardUpdate?.()
    let forwarded = false
    try {
      forwarded = await delivery.answer(actionId === 'approve')
      this.logger.debug(`${channel} ${forwarded ? '已向 Runtime 转发审批决定' : '审批决定未转发'}`)
    } finally {
      if (!forwarded) cancelCardUpdate?.()
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
    if (!config || !this.manager?.get(channel)?.isConnected())
      throw new ServiceUnavailableException('此渠道机器人暂不可用')
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
    if (![...this.channels.keys()].some((channel) => this.manager?.get(channel)?.isConnected()))
      return []
    const bindings = await this.bindings(userId)
    const dingtalk = this.channels.get('dingtalk')
    if (dingtalk) {
      const binding = bindings.find(({ channel }) => channel === 'dingtalk')
      if (!this.manager?.get('dingtalk')?.isConnected())
        this.logger.debug('dingtalk 未选为收件渠道：机器人未就绪')
      else if (!binding) this.logger.debug('dingtalk 未选为收件渠道：当前账号未绑定当前机器人应用')
      else if (!binding.enabled) this.logger.debug('dingtalk 未选为收件渠道：当前账号未启用通知')
    }
    return bindings.filter(
      (binding) => binding.enabled && this.manager?.get(binding.channel)?.isConnected(),
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
    const cards = this.cards.get(recipient.channel)
    if (!cards || notice.expiresAt <= Date.now() || !(await this.isCurrent(recipient))) return
    const reference = `审批编号 ${notice.approvalId.slice(0, 8)}`
    const body = `${reference}\n设备：${deviceName.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim() || '未命名设备'}\n${notice.summary}`
    const title = 'RCM 操作审批'
    const approve = { id: 'approve', label: '批准', style: 'primary' } as const
    const deny = { id: 'deny', label: '拒绝', style: 'secondary' } as const
    const ref = await cards.send(
      recipient.platformUserId,
      // 所有审批渠道统一左侧拒绝、右侧批准，按钮文案与动作保持同序。
      {
        title,
        body,
        buttons: [deny, approve],
      },
      this.channels.get(recipient.channel)?.cardOptions,
    )
    this.logger.debug(`${recipient.channel} 审批卡片已投递`)
    this.deliveries.set(recipient.channel + ':' + ref.cardId, {
      recipient,
      body,
      reference,
      expiresAt: notice.expiresAt,
      answer,
    })
    return ref
  }

  /** 清除决策路由并更新原卡；无法更新时，仅向仍有效的绑定补发结算文本。 */
  async close(ref: CardRef, status: ApprovalStatus) {
    const key = ref.botId + ':' + ref.cardId
    const delivery = this.deliveries.get(key)
    this.deliveries.delete(key)
    const cards = this.cards.get(ref.botId)
    if (!cards || !delivery) return
    const title = messages[status]
    await cards.settle(
      ref,
      { title, body: delivery.body, buttons: [] },
      {
        resultText: async () => {
          if (await this.isCurrent(delivery.recipient)) return `${title}\n${delivery.reference}`
        },
      },
    )
  }
}
