import { env } from './config/env'
import { randomBytes, randomUUID } from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'
import { createDatabaseConnection } from './infrastructure/database/database'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq } from 'drizzle-orm'
import * as bcrypt from 'bcryptjs'
import * as S from './infrastructure/database/schema'

/**
 * Initialize the administrator once. The generated password is printed only
 * on the first successful initialization, not on subsequent deploys.
 */
async function main() {
  const email = env.adminEmail
  if (!/^\S+@\S+\.\S+$/.test(email)) throw Error('Valid ADMIN_EMAIL required')

  const conn = await createDatabaseConnection(env.databaseUrl)
  let locked = false
  try {
    const [rows] = await conn.execute<RowDataPacket[]>(
      "SELECT GET_LOCK('rcm:admin:init', 15) AS acquired",
    )
    if (rows[0]?.acquired !== 1) throw Error('Admin bootstrap is busy')
    locked = true
    const db = drizzle(conn)
    const existing = await db
      .select({ id: S.users.id })
      .from(S.users)
      .where(eq(S.users.role, 'super_admin'))
      .limit(1)
    if (existing.length) {
      process.stdout.write('Super administrator already exists; no changes made.\n')
      return
    }
    const taken = await db
      .select({ id: S.users.id })
      .from(S.users)
      .where(eq(S.users.email, email))
      .limit(1)
    if (taken.length) throw Error('ADMIN_EMAIL already belongs to another account')

    const password = randomBytes(24).toString('base64url')
    const passwordHash = await bcrypt.hash(password, 12)
    await db.insert(S.users).values({
      id: randomUUID(),
      email,
      passwordHash,
      role: 'super_admin',
      status: 'active',
      passwordChangeRequired: true,
    })

    // Deliberately visible in first-deploy logs for this internal development
    // deployment. Do not log the temporary password on subsequent restarts.
    process.stdout.write(
      '\n========== INITIAL SUPER ADMIN CREDENTIALS ==========\n' +
        `Email: ${email}\nTemporary password: ${password}\n` +
        'Change the temporary password at the first login.\n' +
        '=====================================================\n\n',
    )
  } finally {
    if (locked) await conn.execute("SELECT RELEASE_LOCK('rcm:admin:init')")
    await conn.end()
  }
}
main().catch((e: unknown) => {
  process.stderr.write(
    `Administrator initialization failed: ${e instanceof Error ? e.message : String(e)}\n`,
  )
  process.exitCode = 1
})
