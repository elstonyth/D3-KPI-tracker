/**
 * Minimal jest config for @d3/scrapers unit tests. Network (tikhubGet) is
 * mocked in the tests, so these run offline and cost no API credits. Not part
 * of the root `pnpm test` project list — run explicitly:
 *   npx jest --config libraries/scrapers/jest.config.cjs
 */
/** @type {import('jest').Config} */
module.exports = {
  displayName: 'scrapers',
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
  testMatch: ['<rootDir>/src/adapters/*.test.ts'],
};
