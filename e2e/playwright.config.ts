import { defineConfig, devices } from "@playwright/test";

/**
 * Hostidian end-to-end suite. It drives a real browser (the system Chrome: no browser download) against a
 * running stack, e.g. the docker compose stack described in e2e/README.md.
 *
 *   E2E_BASE_URL   origin of the stack (Caddy), default http://localhost:20080. Must equal the stack's PUBLIC_URL.
 *   E2E_WORKERS    parallel workers (default 3)
 *   E2E_RETRIES    retries per failing test (default 0: a flaky test should be fixed, not retried)
 */
const baseURL = (process.env.E2E_BASE_URL ?? "http://localhost:20080").replace(/\/+$/, "");

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: Number(process.env.E2E_RETRIES ?? 0),
  workers: Number(process.env.E2E_WORKERS ?? 3),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    // Creates the instance admin through the real setup form (or signs in when the stack already has one) and
    // saves its session; everything else depends on it.
    {
      name: "onboarding",
      testMatch: /onboarding\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
    {
      name: "chrome",
      testIgnore: /onboarding\.spec\.ts/,
      dependencies: ["onboarding"],
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
});
