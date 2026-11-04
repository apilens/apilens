// "Waiting for your first request" (#334) against the fake identity, which also plays the ingest
// edge (`POST /v1/requests`): the screen polls the ingest status, stops while the tab is hidden,
// shows troubleshooting after three minutes (on Playwright's clock), and once the test sends a
// request with the troubleshooting curl and the key the install step showed, moves on to the
// first data. "Open the project anyway" finishes onboarding on the project.
import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

/** The fake identity, which serves the edge's `/v1/requests` too (playwright.fake.config.ts). */
const FAKE_EDGE = "http://127.0.0.1:18080";
/** `APILENS_PUBLIC_INGEST_URL` as the UI renders it (the default). */
const INGEST_URL = "http://localhost:8080";

/** Signs a new fake user in, walks onboarding to the waiting step and returns the ingest key it showed. */
async function toWaitingStep(page: Page, org: string, project: string, method: RegExp): Promise<string> {
  await page.goto("/sign-in");
  await page.locator("a.ah-btn").filter({ hasText: /^GitHub$/ }).click();
  await page.getByRole("link", { name: "Authorize" }).click();
  await page.goto("/onboarding/about");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/create");
  await page.getByLabel("Name", { exact: true }).fill(org);
  await expect(page.locator(".ob-in .r")).toHaveText("Available");
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/project");
  await page.getByLabel("Name", { exact: true }).fill(project);
  await expect(page.locator(".ob-in .r")).toHaveText("Available");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/instrument");
  await page.getByRole("radio", { name: "Python", exact: true }).click();
  await page.getByRole("radio", { name: /^Docker or VM/ }).click();
  await page.getByRole("radiogroup", { name: "Method" }).getByRole("radio", { name: method }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/install");
  const key = page.getByRole("textbox", { name: "Ingest key" });
  await expect(key).toHaveValue(/^apl_live_[\w-]+$/);
  const raw = await key.inputValue();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding/waiting");
  await expect(page.getByRole("heading", { name: "Waiting for your first request" })).toBeVisible();
  return raw;
}

/** Sets `document.hidden` and fires `visibilitychange`, as switching tabs does. */
async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

const statusLine = (page: Page) => page.getByRole("status").filter({ hasText: /requests yet|background|couldn’t check|arrived/ });

test("waiting: polls, pauses while hidden, troubleshoots, and moves on when a request reaches the edge", async ({ page }) => {
  test.setTimeout(90_000);
  await page.clock.install();
  let polls = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/projects/seinfeld-api/ingest-status")) polls += 1;
  });
  const raw = await toWaitingStep(page, "Seinfeld", "Seinfeld API", /^APILens SDK/);

  // Polling: every 3 s at first.
  await expect(statusLine(page)).toHaveText("No requests yet. Checking every 3 seconds.");
  await expect.poll(() => polls).toBeGreaterThanOrEqual(1);
  const first = polls;
  await expect(async () => {
    await page.clock.runFor(3_000);
    expect(polls).toBeGreaterThan(first);
  }).toPass();

  // Hidden: no polls at all, however long; visible again: one at once.
  await setHidden(page, true);
  await expect(statusLine(page)).toHaveText("Paused while this tab is in the background.");
  const hiddenAt = polls;
  await page.clock.runFor(60_000);
  await page.waitForTimeout(500);
  expect(polls).toBe(hiddenAt);
  await setHidden(page, false);
  await expect.poll(() => polls).toBeGreaterThan(hiddenAt);
  await expect(statusLine(page)).toContainText("No requests yet.");

  // No troubleshooting yet; three minutes in it shows, with the endpoint and a test request.
  await expect(page.getByRole("heading", { name: /Still nothing/ })).toHaveCount(0);
  await page.clock.runFor(3 * 60_000);
  await expect(page.getByRole("heading", { name: /Still nothing/ })).toBeVisible();
  await expect(statusLine(page)).toHaveText("No requests yet. Checking every 10 seconds.");
  const trouble = page.locator(".wt-trouble");
  await expect(trouble).toContainText("APILENS_API_KEY");
  await expect(trouble).toContainText(`${INGEST_URL}/v1`);
  await expect(trouble.getByRole("link", { name: "Create a new key" })).toHaveAttribute("href", "/onboarding/install");
  const curl = await trouble.locator(".ob-code pre").innerText();
  expect(curl).toContain(`curl -sS -X POST ${INGEST_URL}/v1/requests`);
  expect(curl).toContain('"app_id":"seinfeld-api"');
  expect(curl).not.toContain(raw);

  // A wrong key is refused by the edge and nothing changes.
  const send = (key: string) =>
    execFileSync("sh", ["-c", curl.replace(INGEST_URL, FAKE_EDGE)], { env: { ...process.env, APILENS_API_KEY: key }, encoding: "utf8" });
  expect(send("apl_live_wrong")).toContain("authentication_error");

  // The curl as shown, with the key from the install step: the edge takes it and the screen moves on.
  expect(JSON.parse(send(raw))).toEqual({ accepted: 1 });
  await expect(async () => {
    await page.clock.runFor(10_000);
    expect(new URL(page.url()).pathname).toBe("/onboarding/first-data");
  }).toPass();
});

test("waiting: OTLP troubleshooting names the exporter; open the project anyway", async ({ page }) => {
  await page.clock.install();
  await toWaitingStep(page, "Costanza", "Costanza Bets", /^OpenTelemetry/);
  await page.clock.runFor(3 * 60_000);
  const trouble = page.locator(".wt-trouble");
  await expect(trouble).toContainText("OTEL_EXPORTER_OTLP_ENDPOINT");
  await expect(trouble).toContainText(`${INGEST_URL}/otlp`);
  await expect(trouble).toContainText("localhost:8080");

  await page.getByRole("button", { name: "Open the project anyway" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/costanza-bets/") && url.searchParams.get("setup") === "later");
});

// #334: visual check in light and dark at 1440 and 390 px with the troubleshooting open, axe
// finding no serious or critical violations. Screenshots: `AUTH_SHOTS=<dir> pnpm test:e2e:fake onboarding-waiting`.
test("waiting passes axe in light and dark at 1440 and 390 px", async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install();
  await toWaitingStep(page, "Del Boca Vista", "Del Boca Waits", /^APILens SDK/);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.reload();
      await page.clock.runFor(3 * 60_000);
      await expect(page.getByRole("heading", { name: /Still nothing/ })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      const bad = violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")) }));
      expect(bad, `${theme} at ${width} px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const shots = process.env.AUTH_SHOTS;
      if (shots) await page.screenshot({ path: `${shots}/onboarding-waiting-${theme}-${width}.png`, fullPage: true });
    }
  }
});
