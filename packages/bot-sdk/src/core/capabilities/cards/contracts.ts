import type { BotAdapter, Conversation } from '../../contracts.js'

/** 平台为当前连接提供卡片实现的扩展键。 */
export const cardAdapter = Symbol('bot-sdk.cards')

/** 提供卡片能力的连接，工厂只在安装能力时调用。 */
export interface CardConnection extends BotAdapter {
  /** 为本连接创建卡片适配器。 */
  [cardAdapter]?: () => CardAdapter
}

/** 原生交互卡片的通用内容。 */
export interface Card {
  /** 卡片标题。 */
  title: string
  /** 允许向接收者披露的正文。 */
  body: string
  /** 按数组顺序布局，空数组表示无按钮通知卡。 */
  buttons: readonly {
    /** 卡片内唯一的动作标识。 */
    id: string
    /** 用户可见文案。 */
    label: string
    /** 支持样式的平台可区分主次按钮。 */
    style?: 'primary' | 'secondary'
    /** 为 false 时隐藏该按钮，保留模板槽位。 */
    visible?: boolean
  }[]
}

/** 通用双按钮卡片预置；应用可覆盖文案、按钮和事件处理，不附带业务决定。 */
export const defaultCard: Card = {
  title: '交互卡片',
  body: '请选择一个按钮。',
  buttons: [
    { id: 'button1', label: '按钮1', style: 'primary' },
    { id: 'button2', label: '按钮2', style: 'secondary' },
  ],
}

/** 本能力实例发出的卡片引用，更新时须传回原对象。 */
export type CardRef = Conversation & {
  /** 平台消息 ID 或适配器生成的投放 ID。 */
  readonly cardId: string
}

/** 发送时使用的平台配置，例如钉钉卡片模板或企微通知卡链接。 */
export interface CardOptions {
  /** 选项字段由目标平台定义并校验。 */
  readonly [name: string]: unknown
}

/** 原生按钮事件，点击者身份由业务自行授权。 */
export interface ActionEvent {
  /** 发卡的机器人实例 ID。 */
  botId: string
  /** 平台确认的点击者标识。 */
  actorId: string
  /** 卡片投放 ID。 */
  cardId: string
  /** 被点击按钮的业务标识。 */
  actionId: string
  /** 原卡所属会话；优先采用平台回调上下文，否则使用本进程的发卡记录。 */
  conversation?: Conversation
  /** 平台回调中的当前会话 ID；可能是私聊会话，不根据 ID 本身推断为群聊。 */
  chatId?: string
  /** 验证成功后可申请等待异步结果，返回取消等待的函数。 */
  deferCardUpdate?: () => (() => void) | undefined
}

/** 点击回调可以用这张卡替换原卡。 */
export interface ActionResponse {
  /** 回调内的新卡内容。 */
  card: Card
}

/** 卡片适配器的事件出口。 */
export interface CardAdapterEvents {
  /** 交付平台点击事件并接收可选更新。 */
  action(event: ActionEvent): Promise<ActionResponse | void>
  /** 读取发卡时登记的原始配置。 */
  cardOptions(cardId: string): CardOptions | undefined
  /** 汇报不含正文和凭证的错误。 */
  error(error: Error): void
}

/** 卡片能力所需的平台实现。 */
export interface CardAdapter {
  /** 卡片收发共用的已注册连接。 */
  readonly connection: BotAdapter
  /** 是否支持点击回调内更新原卡。 */
  readonly callbackUpdate?: boolean
  /** 回调内等待异步结果的预算，单位毫秒。 */
  readonly callbackUpdateWaitMs?: number
  /** 订阅卡片点击。 */
  start(events: CardAdapterEvents): Promise<void>
  /** 取消卡片订阅。 */
  stop(): Promise<void>
  /** 可选地校验平台字段并复制发卡配置，供投递、点击和更新共用。 */
  prepareOptions?(options?: CardOptions): CardOptions | undefined
  /** 主动发卡；如提前知道投放 ID，可在平台请求前登记。 */
  send(
    to: Conversation,
    card: Card,
    binding: CardOptions | undefined,
    register: (cardId: string) => void,
  ): Promise<string>
  /** 主动更新原卡；未实现则只使用平台可用的回调更新。 */
  update?(ref: CardRef, card: Card, binding?: CardOptions): Promise<void>
}

/** 关闭卡片时原卡更新的可用结果。 */
export type CardSettlement = 'updated' | 'callback' | 'unavailable'

/** 主动更新和回调窗口均不可用时的文本通知选项。 */
export interface CardSettleOptions {
  /** 返回应补发的结果正文，或返回 undefined 跳过。 */
  resultText?: () => string | undefined | Promise<string | undefined>
}

/** 按业务配置使用同一套卡片能力。 */
export interface CardClient {
  /** 主动发送卡片，可覆盖本次使用的场景配置。 */
  send(to: Conversation | string, card: Card, options?: CardOptions): Promise<CardRef>
  /** 使用原卡配置主动更新。 */
  update(ref: CardRef, card: Card): Promise<void>
  /** 关闭卡片交互，并按可用方式更新原卡。 */
  settle(ref: CardRef, card: Card, options?: CardSettleOptions): Promise<CardSettlement>
  /** 注册唯一的按钮处理器，与同一能力的其他客户端共享。 */
  onAction(
    handler: (event: ActionEvent) => ActionResponse | void | Promise<ActionResponse | void>,
  ): () => void
}
