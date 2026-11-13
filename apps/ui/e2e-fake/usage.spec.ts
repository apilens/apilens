// Project settings → Usage (#819) against the fake identity (e2e-fake/fake-identity.ts), which
// serves `GET /projects/shop/usage` from the same seeded edge counters as Ingest health
// (`/__fake/apps` {apps: [{ingest}], quota, usage}). No email is sent by any test here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const USAGE = "/shop/settings/usage";
const SHOP = "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const WORKER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

async function seed(body: Record<string, unknown>) {
  await fetch(`${IDENTITY}/__fake/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function signIn(page: Page, next = USAGE) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, capabilities: ["project.read"] }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === next);
}

const card = (page: Page, name: string) => page.getByRole("region", { name });

/** Shop: yesterday quiet, today with rejections by reason; worker: a little today. */
const TRAFFIC = {
  apps: [
    {
      id: SHOP,
      slug: "shop",
      name: "Shop",
      ingest: [
        { accepted: 1000, rejected: 0, truncated: 0, masked: 10, environments: { production: 800, staging: 200 }, bytes: 2_000_000 },
        { accepted: 900, rejected: 100, truncated: 9, masked: 90, rejected_by: { records_per_minute: 60, invalid: 30 }, environments: { production: 900 }, bytes: 3_000_000 },
      ],
    },
    { id: WORKER, slug: "worker", name: "Worker", ingest: [{ accepted: 50, rejected: 0, truncated: 0, masked: 0, bytes: 100_000 }] },
  ],
  quota: { records_per_minute: 1000, bytes_per_day: 10_000_000 },
};

test.beforeEach(async () => {
  await seed({ apps: [] });
});

test("shows records per day, by app and environment, rejections by reason and the quota", async ({ page }) => {
  await seed(TRAFFIC);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();
  await expect(page).toHaveTitle(/^Usage · Project settings/);
  await expect(card(page, "Accepted records")).toContainText("1,950 records stored and 5.1 MB received in the last 30 days.");

  // The chart: its label is the text alternative; arrowing through the days reads each one.
  const chart = card(page, "Accepted records").getByRole("group", {
    name: /^Records accepted per day, last 30 days \(UTC\)\. 1,950 records accepted in the 30 days, 65 a day on average\. Busiest day .*: 1,000\./,
  });
  await chart.focus();
  const tip = chart.locator(".ct-tip");
  await expect(tip.locator("dd")).toHaveText(["950", "100", "3.1 MB"]);
  await chart.press("ArrowLeft");
  await expect(tip.locator("dd")).toHaveText(["1,000", "0", "2.0 MB"]);

  const apps = card(page, "By app").getByRole("table");
  await expect(apps.getByRole("rowheader")).toHaveText(["shop", "worker"]);
  await expect(apps.getByRole("cell")).toHaveText(["1,900", "100", "50", "0"]);
  const envs = card(page, "By environment").getByRole("table");
  await expect(envs.getByRole("rowheader")).toHaveText(["production", "staging"]);
  await expect(envs.getByRole("cell")).toHaveText(["1,700", "200"]);

  const rejected = card(page, "Rejected records");
  const reasons = rejected.getByRole("table", { name: "Rejected records by reason" });
  await expect(reasons.getByRole("rowheader")).toHaveText([
    "Over the records-per-minute quotarecords_per_minute",
    "Invalid recordinvalid",
    "Reason not recordedunspecified",
  ]);
  await expect(reasons.getByRole("cell")).toHaveText(["60", "30", "10"]);
  await expect(rejected.getByRole("link", { name: "Open Ingest health" })).toHaveAttribute("href", "/shop/settings/ingest");

  const quota = card(page, "Quota");
  const meter = quota.getByRole("meter", { name: "Bytes today" });
  await expect(meter).toHaveAttribute("aria-valuenow", "31");
  await expect(meter).toHaveAttribute("aria-valuetext", "3.1 MB of 10 MB today (31%)");
  await expect(quota.getByRole("definition")).toHaveText(["1,000 records a minute", "10 MB", "60"]);
});

test("numbers match Ingest health for the same days", async ({ page }) => {
  await seed(TRAFFIC);
  await signIn(page, "/shop/settings/ingest");
  const fromHealth: Record<string, string[]> = {};
  for (const app of ["shop", "worker"]) {
    await page.goto(`/shop/settings/ingest?app=${app}`);
    const tiles = page.getByRole("region", { name: "At the ingest edge" }).locator(".ih-tile__value");
    await expect(tiles).toHaveCount(4);
    fromHealth[app] = (await tiles.allTextContents()).slice(0, 2);
  }
  await page.goto(USAGE);
  const rows = card(page, "By app").getByRole("table").getByRole("row");
  await expect(rows.nth(1).getByRole("cell")).toHaveText(fromHealth.shop);
  await expect(rows.nth(2).getByRole("cell")).toHaveText(fromHealth.worker);
});

test("says so when nothing was sent and bytes are unlimited", async ({ page }) => {
  await seed({ apps: [{ id: SHOP, slug: "shop", name: "Shop" }] });
  await signIn(page);
  await expect(card(page, "Accepted records")).toContainText("Nothing reached the ingest edge in the last 30 days.");
  await expect(card(page, "Accepted records").getByRole("group")).toHaveCount(0);
  await expect(card(page, "By app")).toHaveCount(0);
  await expect(card(page, "Rejected records")).toContainText("Nothing rejected.");
  await expect(card(page, "Quota").getByRole("meter")).toHaveCount(0);
  await expect(card(page, "Quota").getByRole("definition")).toHaveText(["Unlimited", "Unlimited", "0"]);
});

test("says so when this install keeps no counters", async ({ page }) => {
  await seed({ apps: [{ id: SHOP, slug: "shop", name: "Shop", ingest: "off" }] });
  await signIn(page);
  await expect(card(page, "No usage counters")).toContainText("This APILens install keeps no ingest counters");
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("says so when the usage could not be loaded", async ({ page }) => {
  await seed({ apps: [{ id: SHOP, slug: "shop", name: "Shop" }], usage: "error" });
  await signIn(page);
  await expect(page.getByRole("alert").filter({ hasText: "Couldn’t load this project’s usage." })).toHaveText("Couldn’t load this project’s usage. Reload the page to try again.");
});

// Visual check (light/dark at 1440 and 390): `USAGE_SHOTS=<dir> pnpm test:e2e:fake usage`.
test("screenshots", async ({ page }) => {
  const dir = process.env.USAGE_SHOTS;
  test.skip(!dir, "set USAGE_SHOTS to a directory to capture screenshots");
  await seed(TRAFFIC);
  await signIn(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.reload();
      await expect(card(page, "Quota")).toBeVisible();
      await page.screenshot({ path: `${dir}/usage-${theme}-${width}.png`, fullPage: true });
    }
  }
});
