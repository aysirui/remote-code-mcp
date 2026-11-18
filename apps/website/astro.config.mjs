import { defineConfig } from 'astro/config'

// 产品官网只生成静态资源，运行时不依赖 Server 和 Console。
export default defineConfig({
  output: 'static',
  site: process.env.PUBLIC_SITE_URL || 'https://example.com',
})
