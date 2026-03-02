module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', 'critical-bugs'],
  collectCoverageFrom: [
    'input-sanitizer.js',
    'ai-provider-manager.js',
    'logger.js',
    'vision-utils.js',
    'vision-handler.js',
    'smart-image-matcher.js',
    'server.js',
    'utils/**/*.js',
    'errors/**/*.js',
    'middleware/**/*.js',
    'config/**/*.js'
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    './input-sanitizer.js': {
      branches: 90,
      functions: 100,
      lines: 100,
      statements: 100
    },
    './errors/AppError.js': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100
    },
    './utils/database.js': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100
    }
  },
  testTimeout: 10000,
  verbose: true,
  // server.js creates setInterval timers and app.listen() which keep node alive
  forceExit: true
};
