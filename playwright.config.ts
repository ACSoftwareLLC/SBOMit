import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against `next dev`, which provides real Cloudflare
 * D1 bindings locally via initOpenNextCloudflareForDev() (see next.config.ts).
 * Requires local D1 migrations to be applied: npm run db:migrate.
 *
 * Port 3100 avoids colliding with a dev server running on 3000.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npx next dev -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
