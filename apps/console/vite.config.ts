import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  // 代理目标只在 Vite 开发服务器使用，浏览器始终请求 localhost 同源接口。
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const target = new URL(env.VITE_API_URL || 'http://localhost:3000')
  const proxy: ProxyOptions = {
    target: target.origin,
    changeOrigin: true,
    cookieDomainRewrite: '',
    configure(serverProxy) {
      serverProxy.on('proxyReq', (proxyReq) => {
        // 后端 CSRF/Origin 校验只允许受信任的服务端来源。
        // 代理不负责授权，Cookie + CSRF Token 仍由后端验证。
        proxyReq.setHeader('origin', target.origin)
        proxyReq.setHeader('referer', target.origin + '/console')
      })
    },
  }

  return {
    plugins: [vue()],
    server: {
      port: 5173,
      proxy: {
        '/api': proxy,
        '/oauth': proxy,
        '/.well-known': proxy,
        '/mcp': proxy,
      },
    },
  }
})
