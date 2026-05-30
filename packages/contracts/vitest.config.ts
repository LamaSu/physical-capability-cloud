import { defineConfig } from "vitest/config";

/**
 * vitest config for @pcc/contracts.
 *
 * The contracts package has a TypeScript layer (ABIs, helpers, types) that
 * is tested with vitest, but the package ALSO contains:
 *   - Solidity sources + tests under src/ and test/ (run by forge, not vitest)
 *   - lib/openzeppelin-contracts submodule which contains hardhat tests
 *     (e.g. lib/openzeppelin-contracts/test/access/AccessControl.test.js)
 *
 * Without explicit excludes, vitest globs lib/** and tries to run ~117
 * hardhat tests from the openzeppelin submodule — they fail because hardhat
 * runtime isn't installed, but more importantly they have nothing to do
 * with our TypeScript code.
 *
 * Keep this exclude list aligned with what's NOT TypeScript-with-vitest.
 */
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cache/**",
      "**/out/**",
      "**/.git/**",
      "lib/**",
    ],
  },
});
