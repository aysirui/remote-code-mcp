import { writeFile } from 'node:fs/promises'
import { defineConfig } from 'astro/config'

// 仅使用部署时配置的官网源地址，避免把示例域名写入索引。
const site = process.env.PUBLIC_SITE_URL ? new URL('/', process.env.PUBLIC_SITE_URL) : undefined

// 产品官网只生成静态资源，运行时不依赖 Server 和 Console。
export default defineConfig({
  output: 'static',
  site: site?.href,
  integrations: site
    ? [
        {
          name: 'rcm-website-sitemap',
          hooks: {
            // 从生成的页面路径创建官网 sitemap，文档有独立的 sitemap。
            async 'astro:build:done'({ dir, pages }) {
              const entries = pages.map(({ pathname }) => {
                const url = new URL(pathname, site).href.replaceAll('&', '&amp;')
                return `  <url><loc>${url}</loc></url>`
              })
              await writeFile(
                new URL('sitemap.xml', dir),
                [
                  '<?xml version="1.0" encoding="UTF-8"?>',
                  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
                  ...entries,
                  '</urlset>',
                  '',
                ].join('\n'),
              )
            },
          },
        },
      ]
    : [],
})
