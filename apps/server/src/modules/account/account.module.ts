import { Module } from '@nestjs/common'
import { DeviceModule } from '../device/device.module'
import { AccountRepository } from './account.repository'
import { AccountService } from './account.service'
import { AccountController } from './account.controller'

/** account 领域 HTTP 接口模块；身份与数据库服务全局共享，设备在线状态由 DeviceModule 提供。 */
@Module({
  imports: [DeviceModule],
  controllers: [AccountController],
  providers: [AccountRepository, AccountService],
})
export class AccountModule {}
