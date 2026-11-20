/** 可写入运维日志的平台错误；消息不得含凭证、收件人或业务正文。 */
export class BotPlatformError extends Error {
  /** 创建可公开的错误描述。 */
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** 已安装的能力对目标连接不支持所请求的操作。 */
export class UnsupportedCapabilityError extends BotPlatformError {
  /** 能力名随操作返回，供调用方判断。 */
  constructor(readonly capability: string) {
    super(`当前机器人不支持该能力：${capability}`)
  }
}

/** 功能缺少所需的配置，或配置与平台不匹配。 */
export class BotConfigurationError extends BotPlatformError {}
