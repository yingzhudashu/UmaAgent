import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: [
        "packages/core/src/**/*.ts",
        "packages/protocol/src/**/*.ts",
        "packages/client/src/**/*.ts",
        "apps/server/src/**/*.ts",
      ],
      exclude: ["**/*.d.ts", "apps/server/src/main.ts", "packages/core/src/document-worker.ts"],
      thresholds: {
        "packages/core/src/**": { branches: 80 },
        "packages/protocol/src/**": { branches: 80 },
        "packages/client/src/**": { branches: 80 },
        "apps/server/src/**": { branches: 80 },
      },
    },
  },
});
