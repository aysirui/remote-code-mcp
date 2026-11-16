import { BadRequestException } from '@nestjs/common'

/** 严格解析分页参数；旧客户端未传分页参数时保留原有数组响应。 */
export function parsePagination(query: Record<string, unknown>) {
  if (query.page === undefined && query.pageSize === undefined) return undefined
  const integer = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
      throw new BadRequestException('分页参数必须为正整数')
    const number = Number(value)
    if (!Number.isSafeInteger(number) || number > max)
      throw new BadRequestException('分页参数超出范围')
    return number
  }
  const page = integer(query.page, 1, 1000000)
  const pageSize = integer(query.pageSize, 20, 100)
  return { page, pageSize, offset: (page - 1) * pageSize }
}
