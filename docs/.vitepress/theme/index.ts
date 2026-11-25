// 引入 VitePress 客户端的静态资源类型，使编辑器能够识别 CSS 样式导入。
/// <reference types="vitepress/client" />

import { defineComponent, h } from 'vue'
import { useData } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './style.css'

/** 保留默认文档主题，并在桌面和窄屏导航中使用部署配置的控制台入口。 */
export default {
  extends: DefaultTheme,
  Layout: defineComponent({
    setup() {
      const { theme } = useData<{
        /** 官网与文档共用的控制台公开地址，独立构建时可省略。 */
        consoleUrl?: string
      }>()

      return () => {
        const href = theme.value.consoleUrl || (import.meta.env.DEV ? 'http://localhost:5173' : '')
        if (!href) return h(DefaultTheme.Layout)

        return h(DefaultTheme.Layout, null, {
          'nav-bar-content-after': () =>
            h('a', { class: 'console-link console-link-desktop', href }, '返回控制台'),
          // 窄屏入口放入展开菜单，避免挤占标题、搜索与菜单按钮的空间。
          'nav-screen-content-after': () =>
            h('a', { class: 'console-link console-link-mobile', href }, '返回控制台'),
        })
      }
    },
  }),
} satisfies Theme
