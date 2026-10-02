module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // '/\.claude/' excludes .claude/worktrees/* — stale worktree copies of the
  // whole repo (including their own tests/) that Jest was otherwise sweeping
  // up and running a second (and third...) time.
  testPathIgnorePatterns: ['/node_modules/', '/\\.claude/', 'critical-bugs'],
  // testPathIgnorePatterns only governs which *.test.js files run — Jest's
  // haste-map still indexes every file (including __mocks__/fs.js inside
  // each worktree) for module resolution, which is what actually produced
  // the "duplicate manual mock" warning. This keeps the whole directory out
  // of module resolution too.
  modulePathIgnorePatterns: ['<rootDir>/\\.claude/'],
  collectCoverageFrom: [
    'input-sanitizer.js',
    'ai-provider-manager.js',
    'logger.js',
    'vision-handler.js',
    'audio-handler.js',
    'pricing/*.js',
    'rag/*.js',
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
