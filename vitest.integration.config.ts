import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    hookTimeout: 120_000,
    testTimeout: 120_000,
    coverage: { enabled: false }
  }
});
