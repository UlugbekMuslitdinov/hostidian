import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // jsdom spin-up for the first markdown call is slow on cold machines.
    testTimeout: 30_000,
  },
});
