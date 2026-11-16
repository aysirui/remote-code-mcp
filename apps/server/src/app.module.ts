import { Module } from '@nestjs/common'
import { DatabaseModule } from './infrastructure/database/database.module'
import { CoreModule } from './modules/core/core.module'
import { AuthModule } from './modules/auth/auth.module'
import { AccountModule } from './modules/account/account.module'
import { AdminModule } from './modules/admin/admin.module'
import { DeviceModule } from './modules/device/device.module'
import { OAuthModule } from './modules/oauth/oauth.module'
import { McpModule } from './modules/mcp/mcp.module'

/** 应用模块装配：数据库与身份服务全局共享，设备通道由 DeviceModule 单独持有，MCP 接口由 McpModule 注册。 */
@Module({
  imports: [
    DatabaseModule,
    CoreModule,
    AuthModule,
    DeviceModule,
    AccountModule,
    AdminModule,
    OAuthModule,
    McpModule,
  ],
})
export class AppModule {}
