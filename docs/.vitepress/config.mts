import { defineConfig } from 'vitepress'

/** 将公开产品文档构建为部署在 Console 同域名 /docs/ 下的静态站点。 */
export default defineConfig({
  // 所有文档链接和构建资源均使用此部署前缀。
  base: '/docs/',
  lang: 'zh-CN',
  title: 'Remote Code MCP',
  description: 'Remote Code MCP 使用、部署与许可证文档',
  // 保留默认 .html 地址，使 Nginx 可直接查找生成的静态页面。
  cleanUrls: false,
  themeConfig: {
    // 导航和侧栏只指向本地生成的产品文档。
    nav: [
      { text: '文档首页', link: '/' },
      { text: '使用指南', link: '/usage' },
      { text: '部署指南', link: '/deployment' },
    ],
    sidebar: [
      {
        text: '项目文档',
        items: [
          { text: '文档首页', link: '/' },
          { text: '使用指南', link: '/usage' },
          { text: '部署指南', link: '/deployment' },
          { text: '许可证说明', link: '/licensing' },
        ],
      },
    ],
    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一篇', next: '下一篇' },
    sidebarMenuLabel: '文档目录',
    returnToTopLabel: '返回顶部',
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    skipToContentLabel: '跳转到正文',
    // 索引随静态站点生成，搜索无需后端服务或外部账号。
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                displayDetails: '显示详细内容',
                resetButtonTitle: '清除搜索',
                backButtonTitle: '返回',
                noResultsText: '未找到相关结果',
                footer: {
                  selectText: '选择',
                  selectKeyAriaLabel: '回车键',
                  navigateText: '切换',
                  navigateUpKeyAriaLabel: '向上键',
                  navigateDownKeyAriaLabel: '向下键',
                  closeText: '关闭',
                  closeKeyAriaLabel: '退出键',
                },
              },
            },
          },
        },
      },
    },
    notFound: {
      title: '页面不存在',
      quote: '请检查文档地址，或返回首页继续阅读。',
      linkLabel: '返回文档首页',
      linkText: '返回文档首页',
    },
  },
})
