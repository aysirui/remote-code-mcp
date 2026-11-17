import { MailModule } from '../mail/mail.module'
import { Module } from '@nestjs/common'
import { AuthService } from './auth.service'
import { AuthController } from './auth.controller'

/** auth 领域 HTTP 接口模块；共享依赖由全局 CoreModule 提供。 */
@Module({ imports: [MailModule], controllers: [AuthController], providers: [AuthService] })
export class AuthModule {}
