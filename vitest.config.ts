import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/web/test/**/*.test.ts",
      "spikes/*/src/**/*.test.ts",
    ],
  },
});
