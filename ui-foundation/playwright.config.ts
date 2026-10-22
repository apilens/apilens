import { defineConfig, devices } from "@playwright/test";

// Visual regression for the design system. Baselines live next to the spec
// (tests/visual.spec.ts-snapshots/). Update them only after looking at the
// diff and agreeing the change is intended: pnpm test:visual:update
export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled", caret: "hide" } },
  use: { baseURL: "http://localhost:3101", colorScheme: "dark" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: {
    command: "pnpm build && pnpm exec next start -p 3101",
    url: "http://localhost:3101/design",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
