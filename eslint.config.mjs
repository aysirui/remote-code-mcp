import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // 1. 全局忽略文件
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      // Astro 自动生成的类型和内容索引，不属于项目源码。
      '**/.astro/**',
      // output 是本地导出目录，不属于当前工作区源码。
      'output/**',
      // VitePress 开发缓存是自动生成的编译结果。
      'docs/.vitepress/cache/**',
      '**/coverage/**',
      '**/.output/**',
      '**/.generated/**',
      '**/*.min.js',
      '**/*.d.ts',
      '**/drizzle/meta/**',
      '**/pnpm-lock.yaml',
    ],
  },

  // 2. TypeScript / JavaScript
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': 'off',
    },
  },

  // 3. Vue SFC
  ...pluginVue.configs['flat/recommended'],

  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/html-self-closing': 'off',
    },
  },

  // 4. 浏览器环境
  {
    files: [
      'apps/console/**/*.{ts,js}',
      'apps/runtime/web/**/*.{ts,js}',
      'packages/ui/**/*.{ts,js}',
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // 5. Jest
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/test/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },

  // 6. Prettier 兼容配置，必须放在最后
  eslintConfigPrettier,
)
