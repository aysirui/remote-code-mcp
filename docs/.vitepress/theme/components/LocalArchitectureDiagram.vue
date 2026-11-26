<script setup lang="ts">
// 架构图仅描述产品组件关系，不依赖第三方绘图库。
const tools = [
  { name: 'File', description: '文件读写', path: 'M3 7h7l2 2h9v11H3z M3 7V4h7l2 3' },
  {
    name: 'Git',
    description: '版本控制',
    path: 'M7 6v12 M17 6v3a6 6 0 0 1-6 6H7 M5 4h4v4H5z M15 4h4v4h-4z M5 16h4v4H5z',
  },
  { name: 'Command', description: '命令执行', path: 'M3 4h18v16H3z M7 8l4 4-4 4 M13 16h4' },
]
</script>

<template>
  <figure
    class="architecture"
    aria-label="RCM 本地运行架构：AI 客户端与浏览器经 ngrok 访问本机 Console 和 Server，Runtime 直接连接 Server">
    <div class="pair">
      <div class="node">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="7" width="16" height="13" rx="3" />
          <path d="M12 7V3 M9 3h6 M8 12h.01 M16 12h.01 M9 16h6" />
        </svg>
        <strong>AI 客户端</strong>
        <small>ChatGPT / WorkBuddy / 豆包等</small>
      </div>
      <div></div>
      <div class="node">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18 M8 13h8 M8 16h5" />
        </svg>
        <strong>浏览器</strong>
        <small>Console 登录与 OAuth 授权</small>
      </div>
    </div>
    <div class="merge">
      <svg viewBox="0 0 300 54" preserveAspectRatio="none" aria-hidden="true">
        <path d="M75 2v13h75v35 M225 2v13h-75 M145 44l5 6 5-6 M70 8l5-6 5 6 M220 8l5-6 5 6" />
      </svg>
      <span>HTTPS / MCP / OAuth</span>
    </div>
    <section class="layer cloud" aria-label="公网 HTTPS 入口">
      <div class="layer-title">公网 HTTPS 入口</div>
      <div class="node">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 18h11a4 4 0 0 0 0-8 6 6 0 0 0-11-2 5 5 0 0 0 0 10z M9 13h6 M12 10v6" />
        </svg>
        <strong>ngrok</strong>
        <span>example.ngrok-free.app</span>
        <small>临时公网域名 · HTTPS 隧道</small>
      </div>
    </section>
    <div class="connection">
      <svg viewBox="0 0 20 64" aria-hidden="true">
        <path d="M10 4v56 M5 10l5-6 5 6 M5 54l5 6 5-6" />
      </svg>
      <span>
        隧道转发
        <br />
        localhost:5173
      </span>
    </div>
    <section class="layer local" aria-label="用户本机">
      <div class="layer-title">用户本机 / 开发电脑</div>
      <div class="node">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
        <strong>Console / Vite</strong>
        <span>localhost:5173</span>
        <small>管理页面 · 同源开发代理</small>
        <div class="routes">
          <code>/api</code>
          <code>/oauth</code>
          <code>/.well-known</code>
          <code>/mcp</code>
          <code>/health</code>
          <code>/agent/connect</code>
        </div>
      </div>
      <div class="connection">
        <svg viewBox="0 0 20 64" aria-hidden="true">
          <path d="M10 4v56 M5 10l5-6 5 6 M5 54l5 6 5-6" />
        </svg>
        <span>
          HTTP / WebSocket
          <br />
          VITE_PROXY_TARGET
        </span>
      </div>
      <div class="pair">
        <div class="node">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="3" width="18" height="8" rx="2" />
            <rect x="3" y="13" width="18" height="8" rx="2" />
            <path d="M7 7h.01 M7 17h.01" />
          </svg>
          <strong>MCP Server</strong>
          <span>localhost:3000</span>
          <small>认证、授权、请求转发</small>
        </div>
        <div class="bridge" aria-label="数据库读写">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h18l-4-4 M21 16H3l4 4" /></svg>
          <small>SQL</small>
        </div>
        <div class="node">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <ellipse cx="12" cy="5" rx="8" ry="3" />
            <path d="M4 5v14c0 4 16 4 16 0V5 M4 12c0 4 16 4 16 0" />
          </svg>
          <strong>MySQL</strong>
          <small>本地账号、设备与授权数据</small>
        </div>
      </div>
      <div class="runtime-link">
        <svg viewBox="0 0 300 68" preserveAspectRatio="none" aria-hidden="true">
          <path d="M75 2v64 M70 8l5-6 5 6 M70 60l5 6 5-6" />
        </svg>
        <span>
          Runtime 主动连接
          <br />
          WebSocket / HTTP 文件流
        </span>
      </div>
      <div class="pair">
        <div class="node">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="3" width="18" height="13" rx="2" />
            <path d="M12 16v5 M8 21h8" />
          </svg>
          <strong>Runtime</strong>
          <small>权限检查、审批、工具执行</small>
        </div>
        <div class="bridge" aria-label="本地管理通信">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h18l-4-4 M21 16H3l4 4" /></svg>
        </div>
        <div class="node">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18 M8 13h8 M8 16h5" />
          </svg>
          <strong>本地管理页面</strong>
          <small>仅回环访问 · 工作区及权限设置</small>
        </div>
      </div>
      <div class="workspace-connection">
        <svg viewBox="0 0 20 32" aria-hidden="true"><path d="M10 2v28 M5 24l5 6 5-6" /></svg>
      </div>
      <div class="workspace">
        <strong>已授权工作区</strong>
        <div class="tool-grid">
          <div v-for="tool in tools" :key="tool.name" class="node tool">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="tool.path" /></svg>
            <strong>{{ tool.name }}</strong>
            <small>{{ tool.description }}</small>
          </div>
        </div>
      </div>
    </section>
    <figcaption>RCM 本地运行架构 · ngrok 仅公开 Console 入口，无需官方 RCM 服务</figcaption>
  </figure>
</template>

<style scoped>
.architecture {
  margin: 24px 0;
  padding: 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  line-height: 1.5;
}
.node {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 18px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
  text-align: center;
}
.node strong {
  font-size: 17px;
  font-weight: 650;
}
.node span,
.node small,
.data,
.layer-title {
  color: var(--vp-c-text-2);
}
.node small {
  font-size: 13px;
}
.architecture svg {
  width: 25px;
  height: 25px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.connection {
  display: grid;
  grid-template-columns: 1fr 20px 1fr;
  align-items: center;
  gap: 8px;
  min-height: 76px;
}
.connection svg {
  grid-column: 2;
  width: 20px;
  height: 60px;
  color: var(--vp-c-text-3);
}
.connection span {
  font-size: 12px;
  color: var(--vp-c-text-2);
}
.layer {
  padding: 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
}
.cloud {
  background: var(--vp-c-bg-alt);
}
.layer-title {
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 600;
}
.pair {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) 42px minmax(0, 1fr);
  align-items: stretch;
}
.bridge {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: var(--vp-c-text-3);
}
.bridge small {
  font-size: 9px;
}
.data {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 14px;
  font-size: 12px;
  text-align: center;
}
.data svg {
  flex: 0 0 17px;
  height: 17px;
}
.workspace-connection {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) 42px minmax(0, 1fr);
  justify-items: center;
  height: 36px;
  color: var(--vp-c-text-3);
}
.workspace-connection svg {
  width: 20px;
  height: 32px;
}
.workspace {
  padding: 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  text-align: center;
}
.tool-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}
.tool {
  padding: 12px 4px;
}
.tool strong {
  font-size: 14px;
}
.architecture figcaption {
  margin-top: 14px;
  color: var(--vp-c-text-3);
  text-align: center;
  font-size: 12px;
}
@media (max-width: 520px) {
  .architecture {
    padding: 10px;
  }
  .layer {
    padding: 10px;
  }
  .pair,
  .workspace-connection {
    grid-template-columns: minmax(0, 1fr) 26px minmax(0, 1fr);
  }
  .bridge svg {
    width: 18px;
  }
  .bridge small {
    font-size: 8px;
  }
  .node {
    padding: 12px 5px;
  }
  .node strong {
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  .node small {
    font-size: 11px;
  }
  .workspace {
    padding: 8px;
  }
  .tool-grid {
    gap: 4px;
  }
  .tool strong {
    font-size: 12px;
  }
}
.merge,
.runtime-link {
  position: relative;
  height: 76px;
}
.merge svg,
.runtime-link svg {
  width: 100%;
  height: 100%;
  color: var(--vp-c-text-3);
  stroke-width: 1;
}
.merge span,
.runtime-link span {
  position: absolute;
  left: 53%;
  top: 45%;
  font-size: 11px;
  color: var(--vp-c-text-2);
}
.runtime-link svg path {
  vector-effect: non-scaling-stroke;
}
.routes {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 5px;
}
.routes code {
  font-size: 11px;
}
</style>
