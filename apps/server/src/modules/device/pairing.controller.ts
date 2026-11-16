import { Controller, Post, Req, Body } from '@nestjs/common'
import type { Request } from 'express'
import { Identity } from '../core/identity'
import { PairingService } from './pairing.service'
import { csrf, checkOrigin } from '../../common/http-security'

/** 设备配对流程；创建一次性配对码，通过事务与行锁保护批准及凭据领取。 */
@Controller('api')
export class PairingController {
  constructor(
    private readonly id: Identity,
    private readonly pairing: PairingService,
  ) {}
  /** Runtime 用设备凭据解除绑定；Service 保证事务提交后断连。 */
  @Post('device/unpair') async unpair(@Req() req: Request) {
    return this.pairing.unpair(req.headers.authorization || '')
  }

  /** Runtime 申请一次性配对码，Origin 检查必须在持久化前执行。 */
  @Post('device/pairing/start') async startPair(
    @Req() req: Request,
    @Body() b: Record<string, unknown>,
  ) {
    checkOrigin(req)
    return this.pairing.startPair(b)
  }

  /** 用户批准配对；身份及 CSRF 校验留在 HTTP 边界。 */
  @Post('device/pairing/approve') async approvePair(
    @Req() req: Request,
    @Body() b: Record<string, unknown>,
  ) {
    csrf(req)
    const user = await this.id.requireUser(req)
    return this.pairing.approvePair(user.id, b.code)
  }

  /** Runtime 使用私有凭据一次性领取设备令牌。 */
  @Post('device/pairing/complete') async completePair(@Body() b: Record<string, unknown>) {
    return this.pairing.completePair(b)
  }
}
