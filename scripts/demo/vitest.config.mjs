// Vitest config for the buyer-agent demo tests.
//
// Run (uses any workspace package's vitest v1 binary):
//   cd /tmp/wt-buyer
//   packages/gateway/node_modules/.bin/vitest run \
//     --root scripts/demo --config scripts/demo/vitest.config.mjs
//
// The tests are pure (no network, no keys), so this is safe to run anywhere.
export default {
  test: {
    include: ["**/*.test.mjs"],
    environment: "node",
    testTimeout: 20_000,
  },
};
