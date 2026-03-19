/**
 * Vitest config for scripts/__tests__.
 *
 * Run from the repo root via a package that has vitest v1:
 *   cd packages/verifier
 *   node_modules/.bin/vitest run --config ../../scripts/vitest.config.ts
 *
 * Or use the helper npm script added to packages/verifier:
 *   pnpm run test:scripts
 */
export default {
  test: {
    // E2E simulations can take up to 30s each; multiple run in parallel
    testTimeout: 90_000,
    hookTimeout: 30_000,
    // Paths are relative to the CWD where vitest is invoked.
    // When invoked from packages/verifier:
    include: ["../../scripts/__tests__/**/*.test.ts"],
  },
};
