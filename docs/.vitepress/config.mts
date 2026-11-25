import { defineConfig } from 'vitepress'

const siteName = 'Remote Code MCP'
// 文档发布在官网域名的 /docs/，与官网使用同一个构建期公开地址。
const docsBase = '/docs/'
const docsUrl = process.env.PUBLIC_SITE_URL
  ? new URL(docsBase, process.env.PUBLIC_SITE_URL)
  : undefined

/** 将公开文档独立构建到 /docs/，不依赖 Console 发布。 */
export default defineConfig({
  // 所有文档链接和构建资源均使用此部署前缀。
  base: docsBase,
  lang: 'zh-CN',
  title: siteName,
  description: 'Remote Code MCP 使用、部署与许可证文档',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/docs/favicon.svg' }]],
  // 保留默认 .html 地址，使 Nginx 可直接查找生成的静态页面。
  cleanUrls: false,
  sitemap: docsUrl ? { hostname: docsUrl.href } : undefined,
  // 保留页面已声明的 head，并按 VitePress sitemap 的规则生成每页规范地址。
  transformPageData(pageData, { siteConfig }) {
    const head = (pageData.frontmatter.head ??= [])
    head.push(
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: siteName }],
      ['meta', { property: 'og:locale', content: 'zh_CN' }],
      ['meta', { property: 'og:title', content: `${pageData.title} | ${siteName}` }],
      ['meta', { property: 'og:description', content: pageData.description }],
    )
    if (docsUrl) {
      const path = pageData.relativePath
        .replace(/(^|\/)index\.md$/, '$1')
        .replace(/\.md$/, siteConfig.cleanUrls ? '' : '.html')
      const canonical = new URL(path, docsUrl).href
      head.push(
        ['link', { rel: 'canonical', href: canonical }],
        ['meta', { property: 'og:url', content: canonical }],
      )
    }
  },
  themeConfig: {
    // 控制台可能使用独立域名，导航入口使用构建时的公开地址。
    consoleUrl: process.env.PUBLIC_CONSOLE_URL,
    // 文档导航和侧栏指向本地生成的产品文档。
    nav: [
      // 使用官网绝对地址，避免 VitePress 将链接重写到 /docs/。
      ...(docsUrl ? [{ text: '产品官网', link: new URL('/', docsUrl).href, target: '_self' }] : []),
      { text: '文档首页', link: '/' },
      { text: 'AI 工具接入', link: '/connect-clients' },
      { text: '使用指南', link: '/usage' },
      { text: '部署指南', link: '/deployment' },
    ],
    sidebar: [
      {
        text: '项目文档',
        items: [
          { text: '文档首页', link: '/' },
          {
            text: 'AI 工具接入',
            items: [
              { text: '连接远程 MCP Server', link: '/connect-clients' },
              { text: 'ChatGPT 网页聊天', link: '/connect-chatgpt' },
            ],
          },
          { text: '使用指南', link: '/usage' },
          { text: '部署指南', link: '/deployment' },
          { text: '工作区权限与数据流向', link: '/workspace-permissions' },
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
