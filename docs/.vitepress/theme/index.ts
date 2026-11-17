// 引入 VitePress 客户端的静态资源类型，使编辑器能够识别 CSS 样式导入。
/// <reference types="vitepress/client" />

import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './style.css'

/** 保留默认文档主题，并在导航栏添加离开 /docs/ 的同源控制台入口。 */
export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      // 原生链接保留 /console 原路径，不受文档 base 或客户端路由影响。
      'nav-bar-content-after': () =>
        h(
          'a',
          { class: 'console-link console-link-desktop', href: '/console', target: '_self' },
          '返回控制台',
        ),
      // 窄屏入口放入展开菜单，避免挤占标题、搜索与菜单按钮的空间。
      'nav-screen-content-after': () =>
        h(
          'a',
          { class: 'console-link console-link-mobile', href: '/console', target: '_self' },
          '返回控制台',
        ),
    }),
} satisfies Theme
