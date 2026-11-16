import { Module } from '@nestjs/common'
import { DeviceModule } from '../device/device.module'
import { AdminRepository } from './admin.repository'
import { AdminService } from './admin.service'
import { AdminController } from './admin.controller'

/** admin 领域 HTTP 接口模块；身份与数据库服务全局共享，设备在线状态由 DeviceModule 提供。 */
@Module({
  imports: [DeviceModule],
  controllers: [AdminController],
  providers: [AdminRepository, AdminService],
})
export class AdminModule {}
