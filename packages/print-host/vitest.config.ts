import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: { KERNEL_CONFIG: "", KERNEL_CONFIG_FILE: "" },
    poolOptions: { threads: { singleThread: true } },
  },
});
