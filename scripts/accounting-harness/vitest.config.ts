/**
 * Vitest config for scripts/accounting-harness/__tests__.
 *
 * Run from the repo root via a package that has vitest v1:
 *   cd packages/kernel
 *   node_modules/.bin/vitest run --config ../../scripts/accounting-harness/vitest.config.ts
 *
 * Paths are resolved relative to the CWD vitest is invoked from (we assume
 * packages/kernel based on the include glob).
 */
export default {
  test: {
    testTimeout: 30_000,
    hookTimeout: 10_000,
    // Paths relative to packages/kernel
    include: ["../../scripts/accounting-harness/__tests__/**/*.test.ts"],
  },
};
