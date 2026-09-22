import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/preview/**/*.test.ts"], fileParallelism: false, coverage: { enabled: false } } });
