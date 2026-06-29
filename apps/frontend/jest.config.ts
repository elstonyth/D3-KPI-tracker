import type { Config } from 'jest';

// Minimal jest setup for apps/frontend unit tests (added for the Sentry
// scrubber test). Node environment; ts-jest transforms TS with isolatedModules
// so unrelated app type errors don't block focused unit tests.
const config: Config = {
  displayName: 'frontend',
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
          jsx: 'react-jsx',
        },
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/*.{test,spec}.{ts,tsx}'],
  // Mirror the `@gitroom/frontend/*` path alias from tsconfig.base.json so
  // component tests can import modules that use it (ts-jest does not apply
  // tsconfig `paths` to runtime resolution on its own).
  moduleNameMapper: {
    '^@gitroom/frontend/(.*)$': '<rootDir>/src/$1',
  },
};

export default config;
