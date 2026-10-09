import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    // The integration test pulls and boots a Postgres container.
    hookTimeout: 180_000,
  },
});
