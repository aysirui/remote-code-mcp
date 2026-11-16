import { Module } from '@nestjs/common'
import { DeviceModule } from '../device/device.module'
import { OAuthModule } from '../oauth/oauth.module'
import { McpController } from './mcp.controller'

/** MCP 入口通过 NestJS Controller 暴露，依赖 OAuth 和设备领域的现有单例。 */
@Module({
  imports: [OAuthModule, DeviceModule],
  controllers: [McpController],
})
export class McpModule {}
