import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The gateway bundle capture helper needs only this real verifier leaf;
    // the unrelated verifier barrel is not built for print-host acceptance.
    alias: { "@pcc/verifier": fileURLToPath(new URL("../verifier/src/workflow/ephemeral-identity.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    env: { KERNEL_CONFIG: "", KERNEL_CONFIG_FILE: "" },
    poolOptions: { threads: { singleThread: true } },
  },
});
