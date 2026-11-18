// Theme follows the system (#991), against the fake identity: with nothing chosen the app paints
// in the OS colour scheme, the account menu offers Light, Dark and System, and every core page
// passes axe's colour-contrast check in both themes. No email is sent by any test here.
//
// Screenshots of every core page in both themes: `THEME_SHOTS=<dir> pnpm test:e2e:fake theme`.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${IDENTITY}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(204);
};

const bucket = (i: number) => new Date(Date.UTC(2026, 10, 5, 10, 0) + i * 15 * 60_000).toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const SUMMARY = { from: "", to: "", requests: 12_400, client_errors: 310, server_errors: 62, error_rate: 0.03, p50_ms: 38.2, p95_ms: 412.6, p99_ms: 1240, requests_per_minute: 8.61, apdex: 0.912 };
const POINTS = [0, 1, 2, 3].map((i) => ({ ts: bucket(i), requests: [3000, 3400, 2600, 3400][i], client_errors: [60, 100, 50, 100][i], server_errors: [0, 12, 40, 10][i], p95_ms: [380, 420, 610, 300][i] }));
const ENDPOINTS = [
  { method: "GET", path: "/orders/{id}", requests: 8200, client_errors: 290, server_errors: 2, error_rate: 0.035, p50_ms: 31, p95_ms: 220.4, apdex: 0.97 },
  { method: "POST", path: "/charge", requests: 4200, client_errors: 20, server_errors: 60, error_rate: 0.019, p50_ms: 410, p95_ms: 1820, apdex: 0.61 },
];

const split = (requests: number, client_errors: number, server_errors: number) => ({ requests, successful: requests - client_errors - server_errors, client_errors, server_errors });
const consumer = (id: string, name: string, group: string, minutesAgo: number, isNew: boolean, s: ReturnType<typeof split>) => ({
  consumer_id: id,
  consumer_name: name,
  consumer_group: group,
  first_seen: ago(isNew ? 90 : 20 * 24 * 60),
  last_seen: ago(minutesAgo),
  new: isNew,
  ...s,
  sparkline: [100, 300, 200, 600],
});

const request = (i: number, extra: Record<string, unknown> = {}) => ({
  timestamp: ago(3 + i * 7),
  app_id: "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
  method: "GET",
  path: "/orders/{id}",
  raw_path: `/orders/${1000 + i}`,
  status_code: 200,
  response_time_ms: 42,
  request_size: 0,
  response_size: 1234,
  environment: "production",
  ip_address: "203.0.113.7",
  consumer_id: "c_acme",
  consumer_name: "Acme Corp",
  consumer_group: "",
  sampled: true,
  trace_id: `t${String(i).padStart(4, "0")}`,
  ...extra,
});

async function seed() {
  await post("/__fake/traffic", { project: "shop", envs: { "": { summary: SUMMARY, points: POINTS, endpoints: ENDPOINTS } } });
  await post("/__fake/endpoint", {
    project: "shop",
    method: "GET",
    path: "/orders/{id}",
    tabs: {
      requests: {
        summary: { ...split(8200, 290, 2), requests_per_minute: 5.69 },
        points: [0, 1, 2, 3].map((i) => ({ ts: bucket(i), ...split([2000, 2200, 1800, 2200][i], [100, 88, 50, 52][i], i === 1 ? 2 : 0) })),
        consumers: [{ consumer_id: "c_acme", consumer_name: "Acme Corp", ...split(5100, 98, 2) }],
      },
    },
  });
  await post("/__fake/errors", {
    project: "shop",
    buckets: [0, 1, 2, 3].map(bucket),
    requests: [2000, 2200, 1800, 2200],
    rows: [
      { method: "GET", path: "/invoices/{id}", status_code: 404, bucket: 0, count: 100, consumer_id: "c_acme", consumer_name: "Acme Corp" },
      { method: "POST", path: "/invoices", status_code: 422, bucket: 1, count: 80, consumer_id: "c_acme", consumer_name: "Acme Corp", validation_errors: 80 },
      { method: "GET", path: "/invoices/{id}", status_code: 500, bucket: 3, count: 2, consumer_id: "c_acme", consumer_name: "Acme Corp", exceptions: 2 },
    ],
    down: false,
  });
  await post("/__fake/consumers", {
    project: "shop",
    summary: { consumers: 2, new: 1, returning: 1 },
    points: [0, 1, 2, 3].map((i) => ({ ts: bucket(i), consumers: 2, new: i === 2 ? 1 : 0, returning: 1 })),
    consumers: [consumer("usr_1f3a9c", "Priya Shah", "Acme Corp", 2, false, split(1200, 30, 6)), consumer("usr_8b3e26", "", "", 5, true, split(340, 0, 0))],
  });
  await post("/__fake/requests", {
    project: "shop",
    rows: [request(0), request(1, { method: "POST", path: "/charge", raw_path: "/charge", status_code: 502, response_time_ms: 2480 }), request(2, { status_code: 404, response_time_ms: 640 })],
  });
}

async function signIn(page: Page, next: string) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ next }) });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === new URL(next, "http://x").pathname);
}

/** The core pages: every surface in the project sidebar, plus an endpoint's detail. */
const PAGES: { name: string; path: string }[] = [
  { name: "traffic", path: "/project/shop/traffic" },
  { name: "endpoint", path: "/project/shop/endpoints/GET/%2Forders%2F%7Bid%7D" },
  { name: "explore", path: "/project/shop/explore" },
  { name: "errors", path: "/project/shop/errors" },
  { name: "performance", path: "/project/shop/performance" },
  { name: "consumers", path: "/project/shop/consumers" },
  { name: "apps", path: "/project/shop/apps" },
  { name: "changes", path: "/project/shop/changes" },
  { name: "incidents", path: "/project/shop/incidents" },
];

async function contrast(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  return violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.any[0]?.message ?? v.help}`));
}

const theme = (page: Page) => page.locator("html").getAttribute("data-theme");

test("with nothing chosen, the app paints in the system colour scheme", async ({ page }) => {
  await signIn(page, "/project/shop/traffic");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    const [r, g, b] = (bg.match(/\d+/g) ?? []).map(Number);
    const light = (r + g + b) / 3 > 128;
    expect(light, `page background ${bg} in ${scheme}`).toBe(scheme === "light");
  }
});

test("the account menu offers Light, Dark and System, and System follows the OS", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signIn(page, "/project/shop/traffic");
  const menu = async () => {
    await page.getByRole("button", { name: /^Account menu/ }).click();
    return page.getByRole("menu", { name: "Account" });
  };
  let m = await menu();
  await expect(m.getByRole("menuitemradio")).toHaveText(["Light", "Dark", "System"]);
  await expect(m.getByRole("menuitemradio", { name: "System" })).toHaveAttribute("aria-checked", "true");
  if (process.env.THEME_SHOTS) await page.screenshot({ path: `${process.env.THEME_SHOTS}/account-menu.png` });

  await m.getByRole("menuitemradio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  m = await menu();
  await expect(m.getByRole("menuitemradio", { name: "Light" })).toHaveAttribute("aria-checked", "true");

  await m.getByRole("menuitemradio", { name: "System" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

for (const scheme of ["light", "dark"] as const) {
  test(`every core page passes the contrast check in the ${scheme} theme`, async ({ page }) => {
    test.setTimeout(180_000);
    await seed();
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, PAGES[0].path);
    const shots = process.env.THEME_SHOTS;
    const found: Record<string, string[]> = {};
    for (const p of PAGES) {
      await page.goto(p.path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      if (shots) await page.screenshot({ path: `${shots}/${p.name}-${scheme}.png`, fullPage: true });
      expect(await theme(page)).toBe(scheme);
      const bad = await contrast(page);
      if (bad.length) found[p.name] = bad;
    }
    expect(found).toEqual({});
  });
}
