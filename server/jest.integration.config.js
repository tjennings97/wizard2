/**
 * Integration tests (*.int.test.ts): real Postgres, real HTTP server and Socket.io clients.
 * They share one database, so files run one at a time. See src/test/dbUrl.ts for which database.
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.int.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  globalSetup: '<rootDir>/src/test/globalSetup.ts',
  setupFiles: ['<rootDir>/src/test/env.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/test/silenceLogger.ts'],
  maxWorkers: 1,
  testTimeout: 15000,
};
