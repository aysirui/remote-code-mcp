import { Module } from '@nestjs/common'
import { DeviceHub } from './device-hub'
import { PairingRepository } from './pairing.repository'
import { PairingService } from './pairing.service'
import { PairingController } from './pairing.controller'
import { ApprovalChannelService } from './approval-channel.service'

/** 设备领域统一管理连接通道、配对与撤销；DeviceHub 供其他领域查询在线状态。 */
@Module({
  controllers: [PairingController],
  providers: [DeviceHub, PairingRepository, PairingService, ApprovalChannelService],
  exports: [DeviceHub, ApprovalChannelService],
})
export class DeviceModule {}
