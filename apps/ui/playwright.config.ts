// Browser tests against a running stack: `task up` (datastores + Mailpit), then `task dev` (or the
// compose stack). Mail never leaves the machine: identity sends to the dev Mailpit, and the tests
// read codes from its API. Point elsewhere with APILENS_E2E_UI_URL, APILENS_E2E_MAILPIT_URL and
// APILENS_E2E_EDGE_URL (the ingest edge onboarding.spec.ts sends its first request to).
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.APILENS_E2E_UI_URL ?? "http://localhost:3200",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
