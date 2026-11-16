import { Module } from '@nestjs/common'
import { OAuthController } from './oauth.controller'
import { OAuthService } from './oauth.service'
import { OAuthRepository } from './oauth.repository'

/** OAuth 授权、Token 与客户端管理入口；供 MCP 传输层获取同一服务实例。 */
@Module({
  controllers: [OAuthController],
  providers: [OAuthRepository, OAuthService],
  exports: [OAuthService],
})
export class OAuthModule {}
