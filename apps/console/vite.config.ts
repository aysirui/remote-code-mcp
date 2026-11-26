import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  // 公网 API 地址用于 MCP 接入和 OAuth 回跳；开发代理目标可独立指向本地 Server。
  const publicUrl = new URL(env.VITE_API_URL || 'http://localhost:3000')
  const target = new URL(env.VITE_PROXY_TARGET || publicUrl.origin)
  const proxy: ProxyOptions = {
    target: target.origin,
    changeOrigin: true,
    cookieDomainRewrite: '',
    // 保留浏览器真实 Origin 和 Referer，由 Server 校验可信来源及 CSRF。
  }

  return {
    plugins: [vue()],
    server: {
      port: 5173,
      // 仅额外允许配置的公开 API 主机，不开放任意 Host。
      allowedHosts: [publicUrl.hostname],
      proxy: {
        // 在线文档由独立的 VitePress 开发服务提供，保留 /docs/ 路径。
        '/docs': { target: 'http://127.0.0.1:5174' },
        '/api': proxy,
        '/oauth': proxy,
        '/.well-known': proxy,
        '/mcp': proxy,
        '/health': proxy,
        '/agent/connect': { ...proxy, ws: true },
      },
    },
  }
})
