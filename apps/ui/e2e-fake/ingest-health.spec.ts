// Project settings → Ingest health (#602) against the fake identity (e2e-fake/fake-identity.ts),
// which serves shop's apps (`GET /project`), their ingest-edge counters per UTC day
// (`GET /apps/{id}/ingest-stats`, 503 when seeded off) and their SDK counters (`sdk_stats` of
// `GET /apps/{id}/status`). No email is sent by any test here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const INGEST = "/shop/settings/ingest";
const SHOP = "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const WORKER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

async function seedApps(apps: Record<string, unknown>[] = []) {
  await fetch(`${IDENTITY}/__fake/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apps }) });
}

async function signIn(page: Page, capabilities: string[] = ["project.read"]) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: INGEST, capabilities }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === INGEST);
}

const edge = (page: Page) => page.getByRole("region", { name: "At the ingest edge" });
const sdks = (page: Page) => page.getByRole("region", { name: "In the SDKs" });

/** Two days of traffic: yesterday quiet, today with rejections, truncations and masking. */
const INGEST_DAYS = [
  { accepted: 1000, rejected: 0, truncated: 0, masked: 10 },
  { accepted: 900, rejected: 100, truncated: 9, masked: 90 },
];
const SDK_STATS = {
  instances: 2,
  queued_records: 14,
  sent_records: 1900,
  failed_batches: 3,
  dropped_records: 15,
  drop_counts: { retries_exhausted: 12, queue_full: 3, truncated: 4 },
};

test.beforeEach(async () => {
  await seedApps();
});

test("shows the edge counters, the SDK drops by reason and links to the runbook", async ({ page }) => {
  await seedApps([{ id: SHOP, slug: "shop", name: "Shop", ingest: INGEST_DAYS, sdk_stats: SDK_STATS }]);
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Ingest health", level: 1 })).toBeVisible();
  const runbook = page.getByRole("link", { name: "What to do when a counter moves" });
  await expect(runbook).toHaveAttribute("href", /\/ingest\/ingest-health$/);
  await expect(runbook).toHaveAttribute("target", "_blank");

  // Totals over the last 7 days, with shares.
  const tiles = edge(page).getByRole("definition");
  await expect(tiles).toHaveText(["1,900Records stored", "1005% of received", "90.5% of accepted", "1005.3% of accepted"]);
  await expect(edge(page)).toContainText("Records Shop sent in the last 7 days (UTC)");

  // One row per day, newest first.
  const table = edge(page).getByRole("table", { name: "Ingest counters per day" });
  await expect(table.getByRole("columnheader")).toHaveText(["Day (UTC)", "Accepted", "Rejected", "Truncated", "Masked"]);
  const rows = table.getByRole("row");
  await expect(rows).toHaveCount(8);
  await expect(rows.nth(1).getByRole("cell")).toHaveText(["900", "100", "9", "90"]);
  await expect(rows.nth(2).getByRole("cell")).toHaveText(["1,000", "0", "0", "10"]);
  await expect(rows.nth(3).getByRole("cell")).toHaveText(["0", "0", "0", "0"]);

  // The per-day chart: hovering a day (or arrowing to it) shows its exact counters.
  const chart = edge(page).getByRole("group", { name: /^Records received per day, last 7 days \(UTC\)\. Busiest day .*: 1,000 records received\. 100 records rejected/ });
  await chart.focus();
  const tip = chart.locator(".ct-tip");
  await expect(tip.locator("dd")).toHaveText(["900", "100", "9", "90"]);
  await chart.press("ArrowLeft");
  await expect(tip.locator("dd")).toHaveText(["1,000", "0", "0", "10"]);
  const box = await chart.boundingBox();
  if (!box) throw new Error("chart not laid out");
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await expect(tip.locator("dd")).toHaveText(["0", "0", "0", "0"]);

  // What the SDKs lost before sending.
  await expect(sdks(page)).toContainText("3 batches failed · 15 records dropped");
  await expect(sdks(page)).toContainText("Summed over the 2 instances seen in the last hour, since each process started.");
  await expect(sdks(page)).toContainText("Waiting in queues14 records");
  const reasons = sdks(page).getByRole("table", { name: "Dropped records by reason" });
  await expect(reasons.getByRole("rowheader")).toHaveText(["Still failing after retriesretries_exhausted", "Queue full (record limit)queue_full"]);
  await expect(reasons.getByRole("cell")).toHaveText(["12", "3"]);
  await expect(sdks(page)).toContainText("4 records were shortened to fit a batch and still sent.");
});

test("says so when nothing was counted or the install keeps no counters", async ({ page }) => {
  await seedApps([
    { id: SHOP, slug: "shop", name: "Shop" },
    { id: WORKER, slug: "worker", name: "Worker", ingest: "off", sdk_stats: { instances: 1, sent_records: 40 } },
  ]);
  await signIn(page);
  await expect(edge(page).getByRole("definition").first()).toHaveText("0Records stored");
  await expect(sdks(page)).toContainText("No SDK instance sent a heartbeat in the last hour");
  await expect(sdks(page).getByRole("table")).toHaveCount(0);

  const picker = page.getByRole("combobox", { name: /App/ });
  await expect(picker).toHaveValue("shop");
  await picker.selectOption("worker");
  await page.waitForURL((url) => url.searchParams.get("app") === "worker");
  await expect(edge(page)).toContainText("This APILens install keeps no ingest counters");
  await expect(edge(page).getByRole("table")).toHaveCount(0);
  await expect(sdks(page)).toContainText("Nothing dropped by the 1 instance seen in the last hour.");
  await expect(sdks(page)).toContainText("Sent40 records");
});

test("an unknown app in the URL falls back to the project's first app", async ({ page }) => {
  await seedApps([
    { id: SHOP, slug: "shop", name: "Shop", sdk_stats: { instances: 1, failed_batches: 1 } },
    { id: WORKER, slug: "worker", name: "Worker" },
  ]);
  await signIn(page);
  await page.goto(`${INGEST}?app=nope`);
  await expect(page.getByRole("combobox", { name: /App/ })).toHaveValue("shop");
  await expect(sdks(page)).toContainText("1 batch failed");
});

// Visual check (light/dark at 1440 and 390): `INGEST_SHOTS=<dir> pnpm test:e2e:fake ingest-health`.
test("screenshots", async ({ page }) => {
  const dir = process.env.INGEST_SHOTS;
  test.skip(!dir, "set INGEST_SHOTS to a directory to capture screenshots");
  await seedApps([
    { id: SHOP, slug: "shop", name: "Shop", ingest: INGEST_DAYS, sdk_stats: SDK_STATS },
    { id: WORKER, slug: "worker", name: "Worker" },
  ]);
  await signIn(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("theme", t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      await page.reload();
      await expect(edge(page)).toBeVisible();
      await page.screenshot({ path: `${dir}/ingest-${theme}-${width}.png`, fullPage: true });
      await sdks(page).screenshot({ path: `${dir}/ingest-sdk-${theme}-${width}.png` });
    }
  }
});
