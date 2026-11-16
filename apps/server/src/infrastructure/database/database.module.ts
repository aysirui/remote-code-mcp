import { Global, Module } from '@nestjs/common'
import { Store } from './store'

/** 数据库连接和审计持久化由单一全局 Store 提供，避免各业务模块重复创建连接池。 */
@Global()
@Module({ providers: [Store], exports: [Store] })
export class DatabaseModule {}
