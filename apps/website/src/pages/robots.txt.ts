import type { APIRoute } from 'astro'

/** 返回公开站点的爬取规则，并在配置官网域名后声明官网和文档的 sitemap。 */
export const GET: APIRoute = ({ site }) => {
  const lines = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /oauth/',
    'Disallow: /mcp',
  ]

  if (site) {
    lines.push(
      '',
      `Sitemap: ${new URL('/sitemap.xml', site)}`,
      `Sitemap: ${new URL('/docs/sitemap.xml', site)}`,
    )
  }

  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
