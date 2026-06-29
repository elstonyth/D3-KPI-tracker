// Root ESLint flat config (ESLint 9 + eslint-config-next 16, which ships
// flat-native config objects — no FlatCompat / @eslint/eslintrc shim needed).
// The repo's lint entry point delegates to apps/frontend (see root "lint"
// script), which has its own copy of this config; this root file keeps a bare
// `eslint .` and editor integrations working from the repo root too.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const eslintConfig = [
  // Global ignores — lint source only, never build output / generated bundles
  // (e.g. apps/frontend/.vercel holds 89M of 500KB+ JS that OOMs the parser).
  {
    ignores: [
      'node_modules/**',
      '**/.next/**',
      '**/out/**',
      '**/build/**',
      '**/dist/**',
      '**/.swc/**',
      '**/.vercel/**',
      '**/.vercel.bak/**',
      '**/public/**',
      '**/coverage/**',
      '**/storybook-static/**',
      '**/.storybook.disabled/**',
      '**/.git_disabled_hooks/**',
      '**/next-env.d.ts',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // Mirror apps/frontend/eslint.config.mjs so `eslint .` from the repo root
    // (and editor integrations) apply the same deliberate rule overrides as
    // `pnpm run lint` (which runs eslint inside apps/frontend).
    rules: {
      'react/no-unescaped-entities': 'off',
      'react/display-name': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/prefer-as-const': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
    },
  },
  {
    // CommonJS config files legitimately use require().
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
];

export default eslintConfig;
