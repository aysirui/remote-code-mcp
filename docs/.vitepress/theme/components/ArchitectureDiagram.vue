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
    aria-label="RCM 产品架构：AI 客户端通过在线 MCP Server 连接本机 Runtime，访问已授权工作区">
    <div class="node client">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="7" width="16" height="13" rx="3" />
        <path d="M12 7V3 M9 3h6 M8 12h.01 M16 12h.01 M9 16h6" />
      </svg>
      <strong>AI 客户端</strong>
      <span>ChatGPT / WorkBuddy / 豆包等</span>
      <small>理解用户指令、调用工具、分析结果</small>
    </div>

    <div class="connection">
      <svg viewBox="0 0 20 64" aria-hidden="true">
        <path d="M10 4v56 M5 10l5-6 5 6 M5 54l5 6 5-6" />
      </svg>
      <span>
        HTTPS / MCP
        <br />
        OAuth
      </span>
    </div>

    <section class="layer cloud" aria-label="RCM 在线服务">
      <div class="layer-title">RCM 在线服务</div>
      <div class="pair">
        <div class="node">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="3" width="18" height="8" rx="2" />
            <rect x="3" y="13" width="18" height="8" rx="2" />
            <path d="M7 7h.01 M7 17h.01" />
          </svg>
          <strong>MCP Server</strong>
          <small>认证、授权、请求转发</small>
        </div>
        <div class="bridge" aria-label="HTTPS 双向通信">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h18l-4-4 M21 16H3l4 4" /></svg>
          <small>HTTPS</small>
        </div>
        <div class="node">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          <strong>Console</strong>
          <small>账号与设备管理</small>
        </div>
      </div>
      <div class="data">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v14c0 4 16 4 16 0V5 M4 12c0 4 16 4 16 0" />
        </svg>
        <span>账号、设备、授权与脱敏审计数据</span>
      </div>
    </section>

    <div class="connection">
      <svg viewBox="0 0 20 64" aria-hidden="true">
        <path d="M10 4v56 M5 10l5-6 5 6 M5 54l5 6 5-6" />
      </svg>
      <span>
        WSS 双向通信
        <br />
        Runtime 主动连接
      </span>
    </div>

    <section class="layer local" aria-label="用户本机或开发电脑">
      <div class="layer-title">用户本机 / 开发电脑</div>
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
          <small>工作区及权限设置</small>
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
    <figcaption>RCM 产品架构与工具调用路径</figcaption>
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
</style>
