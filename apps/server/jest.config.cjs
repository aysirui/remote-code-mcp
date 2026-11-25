module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // 在加载测试模块之前初始化测试专用环境变量。
  setupFiles: ['<rootDir>/test/setup.ts'],
  testMatch: ['**/test/**/*.test.ts'],
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'test/tsconfig.json' }] },
}
