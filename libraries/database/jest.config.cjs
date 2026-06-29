/**
 * Minimal jest config for @d3/database unit tests. The Supabase admin client is
 * mocked in the tests, so these run offline with no DB connection. Scoped to
 * the snapshot tests; run explicitly:
 *   npx jest --config libraries/database/jest.config.cjs
 */
/** @type {import('jest').Config} */
module.exports = {
  displayName: 'database',
  rootDir: '.',
  testEnvironment: 'node',
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        tsconfig: {
          isolatedModules: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  testMatch: ['<rootDir>/src/snapshots.test.ts'],
};
