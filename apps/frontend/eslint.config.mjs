import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  // Global ignores. Lint source only — never build output / generated /
  // vendored bundles. Without this, `eslint .` walks .vercel (71M of bundled
  // 500KB+ JS), .next (293M), dist and public/f.js and OOMs the parser.
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "dist/**",
      ".swc/**",
      ".tanstack/**",
      ".vercel/**",
      "public/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // Project rule overrides — carried over from the previous (FlatCompat-era)
    // root config so the lint baseline is unchanged by the ESLint 9 migration.
    // These were deliberate project decisions, not accidental noise.
    rules: {
      "react/no-unescaped-entities": "off",
      "react/display-name": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/prefer-as-const": "off",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "off",
    },
  },
  {
    // CommonJS config files legitimately use require().
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];

export default eslintConfig;
