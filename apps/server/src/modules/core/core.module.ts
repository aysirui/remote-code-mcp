import { Global, Module } from '@nestjs/common'
import { Identity } from './identity'

/** 全局身份会话服务；数据库由 DatabaseModule 提供，设备连接由 DeviceModule 管理。 */
@Global()
@Module({ providers: [Identity], exports: [Identity] })
export class CoreModule {}
