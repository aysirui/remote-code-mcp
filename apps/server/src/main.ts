import 'reflect-metadata'
import { env } from './config/env'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import type { Request, Response } from 'express'
import { configureHttp } from './http-bootstrap'
async function main() {
  env.validateServer()
  const app = await NestFactory.create(AppModule, { bodyParser: false })
  configureHttp(app)
  app
    .getHttpAdapter()
    .getInstance()
    .get('/health', (_req: Request, res: Response) => res.json({ ok: true }))
  await app.listen(env.port, '0.0.0.0')
  console.log('Remote Code MCP listening', env.publicUrl)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
