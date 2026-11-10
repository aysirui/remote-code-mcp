import mysql from 'mysql2/promise'

const utcSession = "SET SESSION time_zone = '+00:00'"

/** Drizzle 的 TIMESTAMP 映射使用 UTC，驱动与数据库会话必须保持一致。 */
export function createDatabasePool(url: string) {
  const pool = mysql.createPool({ uri: url, timezone: 'Z' })
  // connection 事件早于连接交付；初始化语句先入队，后续业务查询在其后执行。
  pool.pool.on('connection', (connection) => {
    connection.query(utcSession, (error) => {
      if (error) connection.destroy()
    })
  })
  return pool
}

/** 独立脚本与服务连接采用相同的时区约定。 */
export async function createDatabaseConnection(url: string) {
  const connection = await mysql.createConnection({ uri: url, timezone: 'Z' })
  try {
    await connection.query(utcSession)
    return connection
  } catch (error) {
    connection.destroy()
    throw error
  }
}
