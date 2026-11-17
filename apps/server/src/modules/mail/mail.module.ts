import { Module } from '@nestjs/common'
import { MailService } from './mail.service'

/** SMTP 邮件能力，仅负责发送，不管理账号或激活令牌。 */
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
