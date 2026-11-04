// Browser tests against fakes, no stack needed: `pnpm test:e2e:fake`. Starts a fake identity
// server with a fake OAuth provider (e2e-fake/fake-identity.ts) and a `next dev` pointed at it on
// its own port, so it never touches a real provider, identity or mailbox.
import { defineConfig, devices } from "@playwright/test";

const IDENTITY_PORT = 18080;
const UI_PORT = 3210;
const UI_URL = `http://localhost:${UI_PORT}`;

export default defineConfig({
  testDir: "./e2e-fake",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: UI_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node --experimental-strip-types --no-warnings e2e-fake/fake-identity.ts",
      url: `http://localhost:${IDENTITY_PORT}/healthz`,
      env: { FAKE_IDENTITY_PORT: String(IDENTITY_PORT), FAKE_IDENTITY_UI_URL: UI_URL },
      reuseExistingServer: false,
    },
    {
      command: `pnpm exec next dev -p ${UI_PORT}`,
      url: `${UI_URL}/sign-in`,
      timeout: 120_000,
      env: {
        APILENS_API_URL: `http://127.0.0.1:${IDENTITY_PORT}`,
        // What browsers use for the provider buttons: the same fake, by its public name.
        APILENS_PUBLIC_API_URL: `http://localhost:${IDENTITY_PORT}`,
        // Test-only key; never reuse it anywhere else.
        SESSION_SECRET: "e2e-fake-only-session-secret-0123456789abcdef",
        APILENS_PUBLIC_URL: UI_URL,
      },
      reuseExistingServer: false,
    },
  ],
});
