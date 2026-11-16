import { randomBytes, randomUUID, createHash } from 'node:crypto'

/** 生成用于实体主键的一次性 UUID，不从客户端接收主键。 */
export const uid = () => randomUUID()

/** 创建高熵的会话/设备/OAuth 临时凭据；原值只返回给合法客户端。 */
export const secret = () => randomBytes(32).toString('base64url')

/** 数据库只持久化令牌摘要，不存储可直接使用的会话令牌。 */
export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
