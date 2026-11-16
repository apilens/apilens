// Consumers (#596) against the fake identity (e2e-fake/fake-identity.ts), which plays the query
// role: `GET /consumers`, `GET /consumers/{id}` and `GET /consumer-groups` answer what
// `/__fake/consumers` seeded, searched, sorted and paged like the API. Consumers are the users of
// the customer's API; their group is what the SDK reports (`consumer_group`), never assigned here.
// `/__fake/query-down` makes the reads answer 503. No email is sent by any test here.
import AxeBuilder from "@axe-core/playwright";
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const PAGE = "/shop/consumers";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const bucket = (i: number) => new Date(Date.UTC(2026, 10, 5, 10, 0) + i * 15 * 60_000).toISOString();

const split = (requests: number, client_errors: number, server_errors: number) => ({
  requests,
  successful: requests - client_errors - server_errors,
  client_errors,
  server_errors,
});

const user = (id: string, name: string, group: string, minutesAgo: number, isNew: boolean, s: ReturnType<typeof split>, sparkline: number[]) => ({
  consumer_id: id,
  consumer_name: name,
  consumer_group: group,
  first_seen: ago(isNew ? 90 : 20 * 24 * 60),
  last_seen: ago(minutesAgo),
  new: isNew,
  ...s,
  sparkline,
});

const CONSUMERS = [
  user("usr_1f3a9c", "Priya Shah", "Acme Corp", 2, false, split(1200, 30, 6), [100, 300, 200, 600]),
  user("usr_8b3e26", "", "", 5, true, split(340, 0, 0), [0, 0, 140, 200]),
  user("usr_9c4f31", "Emma Schulz", "Initech", 45, false, split(80, 4, 0), [20, 20, 20, 20]),
];

const POINTS = [
  { ts: bucket(0), consumers: 2, new: 0, returning: 2 },
  { ts: bucket(1), consumers: 2, new: 0, returning: 2 },
  { ts: bucket(2), consumers: 3, new: 1, returning: 2 },
  { ts: bucket(3), consumers: 3, new: 0, returning: 3 },
];

const request = (minutes: number, status: number, path: string) => ({
  id: `r${minutes}-${status}`,
  timestamp: ago(minutes),
  method: "GET",
  path,
  raw_path: path,
  status_code: status,
  response_time_ms: 42.4,
  environment: "production",
  consumer_id: "usr_1f3a9c",
  consumer_name: "Priya Shah",
  consumer_group: "Acme Corp",
  trace_id: `t${minutes}`,
});

const PRIYA = {
  consumer_name: "Priya Shah",
  consumer_group: "Acme Corp",
  first_seen: ago(20 * 24 * 60),
  last_seen: ago(2),
  new: false,
  from: "",
  to: "",
  bucket_seconds: 900,
  summary: { ...split(1200, 30, 6), requests_per_minute: 0.83 },
  points: [
    { ts: bucket(0), ...split(100, 0, 0) },
    { ts: bucket(1), ...split(300, 10, 0) },
    { ts: bucket(2), ...split(200, 20, 6) },
    { ts: bucket(3), ...split(600, 0, 0) },
  ],
  top_endpoints: [
    { method: "GET", path: "/orders/{id}", ...split(900, 20, 0) },
    { method: "POST", path: "/charge", ...split(300, 10, 6) },
  ],
  // 30 recent requests, so the list pages at 25.
  recent_requests: Array.from({ length: 30 }, (_, i) => request(i + 2, i === 1 ? 404 : 200, `/orders/${i + 1}`)),
  recent_errors: [request(3, 404, "/orders/9"), request(9, 503, "/charge")],
};

async function seed(extra: Record<string, unknown> = {}) {
  const res = await fetch(`${IDENTITY}/__fake/consumers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "shop", summary: { consumers: 3, new: 1, returning: 2 }, points: POINTS, consumers: CONSUMERS, details: { usr_1f3a9c: PRIYA }, ...extra }),
  });
  expect(res.status).toBe(204);
}

async function queryDown(down: boolean) {
  await fetch(`${IDENTITY}/__fake/query-down`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "shop", down }),
  });
}

async function signIn(page: Page, next = PAGE, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next, ...extra }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === new URL(next, "http://x").pathname);
}

const usersTable = (page: Page) => page.getByRole("table", { name: /^Users/ });
const groupsTable = (page: Page) => page.getByRole("table", { name: /^Groups/ });

test.afterEach(async () => {
  await queryDown(false);
});

test("charts unique users new vs returning, with exact numbers on hover, and lists users", async ({ page }) => {
  await seed();
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1, name: "Consumers" })).toBeVisible();

  const unique = page.getByRole("region", { name: "Unique users" });
  await expect(unique.locator("dd")).toHaveText(["3", "1", "2"]);
  const chart = unique.getByRole("group", { name: /Unique users over time/ });
  await expect(chart).toHaveAttribute("aria-label", /3 users in the last 24 hours: 1 new, 2 returning/);
  await expect(unique.getByRole("list", { name: /legend/ }).getByRole("listitem")).toHaveText(["Returning", "New"]);
  // Hover (and the keyboard) show one bucket's exact numbers.
  const box = await chart.boundingBox();
  if (!box) throw new Error("no chart");
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await expect(unique.locator(".ct-tip")).toContainText("Users3New1Returning2");
  await chart.focus();
  await page.keyboard.press("Home");
  await expect(unique.locator(".ct-tip")).toContainText("Users2New0Returning2");

  await expect(usersTable(page).getByRole("columnheader")).toHaveText(["User", "Group", /^Requests/, "Errors", "Last seen"]);
  await expect(usersTable(page).getByRole("columnheader", { name: "Requests" })).toHaveAttribute("aria-sort", "descending");
  const rows = usersTable(page).locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByRole("cell").nth(0)).toHaveText("Priya Shahusr_1f3a9c");
  await expect(rows.nth(0).getByRole("cell").nth(1).getByRole("link", { name: "Acme Corp" })).toHaveAttribute("href", "/shop/consumers?group=Acme+Corp");
  await expect(rows.nth(0).getByRole("cell").nth(2)).toHaveText("1,200");
  await expect(rows.nth(0).getByRole("cell").nth(3)).toHaveText("36 (3.0%)");
  await expect(rows.nth(1).getByRole("cell").nth(0)).toHaveText("usr_8b3e26New");
  await expect(rows.nth(1).getByRole("cell").nth(1)).toHaveText("None");
  // A sparkline reads its buckets too.
  const spark = rows.nth(0).getByRole("group", { name: /Requests over time for Priya Shah/ });
  await spark.focus();
  await expect(rows.nth(0).locator(".ct-tip")).toContainText("Requests600");

  // No dashboard group management anywhere.
  await expect(page.getByRole("button", { name: /Create group|Rename|Delete|Save/ })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Group" })).toHaveCount(0);

  const a11y = await new AxeBuilder({ page }).include(".cs").analyze();
  expect(a11y.violations).toEqual([]);
});

test("searches and sorts users, keeping the range in the URL", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?range=7d`);
  await page.getByRole("searchbox", { name: "Search users" }).fill("emma");
  await page.getByRole("button", { name: "Search" }).click();
  await page.waitForURL(/q=emma/);
  expect(new URL(page.url()).searchParams.get("range")).toBe("7d");
  await expect(usersTable(page).locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: /Users 1/ })).toBeVisible();

  await page.goto(`${PAGE}?q=nobody`);
  await expect(page.getByRole("status").filter({ hasText: "No user matches “nobody”" })).toBeVisible();

  await page.goto(PAGE);
  await usersTable(page).getByRole("link", { name: /^Errors/ }).click();
  await page.waitForURL(/sort=errors/);
  await expect(usersTable(page).getByRole("columnheader", { name: "Errors" })).toHaveAttribute("aria-sort", "descending");
  await usersTable(page).getByRole("link", { name: /^Last seen/ }).click();
  await page.waitForURL(/sort=last_seen/);
  await expect(usersTable(page).locator("tbody tr td:first-child a")).toHaveText(["Priya Shah", "usr_8b3e26", "Emma Schulz"]);
});

test("pages the users table, and lands on the last page when past the end", async ({ page }) => {
  const many = Array.from({ length: 30 }, (_, i) => user(`usr_${String(i).padStart(3, "0")}`, `User ${i}`, "Globex Logistics", i, false, split(1000 - i, 0, 0), [1, 2]));
  await seed({ consumers: many, summary: { consumers: 30, new: 0, returning: 30 } });
  await signIn(page);
  const pages = page.getByRole("navigation", { name: "Users pages" });
  await expect(pages.getByText("Showing 1–25 of 30")).toBeVisible();
  await expect(usersTable(page).locator("tbody tr")).toHaveCount(25);
  await pages.getByRole("link", { name: "Page 2" }).click();
  await page.waitForURL(/page=2/);
  await expect(usersTable(page).locator("tbody tr")).toHaveCount(5);
  await expect(pages.getByText("Showing 26–30 of 30")).toBeVisible();

  // A search starts again at page 1.
  await page.getByRole("searchbox", { name: "Search users" }).fill("User 2");
  await page.getByRole("button", { name: "Search" }).click();
  await page.waitForURL(/q=User/);
  expect(new URL(page.url()).searchParams.get("page")).toBeNull();

  await page.goto(`${PAGE}?page=99`);
  await expect(usersTable(page).locator("tbody tr")).toHaveCount(5);
  await expect(pages.getByRole("link", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
});

test("rolls traffic up by the group the SDK reports, and opens a group's users", async ({ page }) => {
  await seed();
  await signIn(page, `${PAGE}?by=groups`);
  await expect(groupsTable(page).getByRole("columnheader")).toHaveText(["Group", "Users", /^Requests/, "Errors", "Last seen"]);
  const rows = groupsTable(page).locator("tbody tr");
  await expect(rows.locator("td:first-child")).toHaveText(["Acme Corp", "Initech"]);
  await expect(rows.nth(0).getByRole("cell").nth(2)).toHaveText("1,200");

  await groupsTable(page).getByRole("link", { name: "Initech" }).click();
  await page.waitForURL(/group=Initech/);
  const group = page.getByRole("region", { name: "Initech" });
  await expect(group.locator("dd")).toHaveText(["1", "80", "4 5.0%"]);
  await expect(group.getByRole("link", { name: "View requests in Explore" })).toHaveAttribute("href", "/shop/explore?range=24h&consumer_group=Initech");
  await expect(usersTable(page).locator("tbody tr")).toHaveCount(1);
  await group.getByRole("link", { name: "← All groups" }).click();
  await expect(groupsTable(page)).toBeVisible();
});

test("opens a user's detail: group, top endpoints, Explore link and paged requests and errors", async ({ page }) => {
  await seed();
  await signIn(page);
  await usersTable(page).getByRole("link", { name: "Priya Shah" }).click();
  await page.waitForURL(/consumer=usr_1f3a9c/);

  const panel = page.getByRole("region", { name: "Priya Shah" });
  await expect(panel.getByRole("heading", { level: 2, name: "Priya Shah" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Acme Corp" }).first()).toHaveAttribute("href", "/shop/consumers?group=Acme+Corp");
  await expect(panel.getByRole("link", { name: "View requests in Explore" })).toHaveAttribute("href", "/shop/explore?range=24h&consumer_id=usr_1f3a9c");
  await expect(panel.locator(".cs-tiles--panel dd").first()).toHaveText("1,200");
  const endpoints = panel.getByRole("table", { name: "Top endpoints" });
  await expect(endpoints.locator("tbody tr")).toHaveCount(2);
  await expect(endpoints.getByRole("link", { name: "GET /orders/{id}" })).toHaveAttribute("href", "/shop/endpoints/GET/%2Forders%2F%7Bid%7D");

  const chart = panel.getByRole("group", { name: /Requests over time/ });
  await chart.focus();
  await expect(panel.locator(".ct-tip")).toContainText("Requests600");

  const tabs = panel.getByRole("navigation", { name: "Latest requests" });
  await expect(tabs.getByRole("link", { name: /Requests/ })).toHaveAttribute("aria-current", "page");
  await expect(panel.getByRole("table", { name: "Latest requests" }).locator("tbody tr")).toHaveCount(25);
  // The fake pages the seeded list; the total is the user's request count.
  await expect(panel.getByRole("navigation", { name: "Latest requests pages" }).getByText("Showing 1–25 of 1,200")).toBeVisible();

  await tabs.getByRole("link", { name: /Errors/ }).click();
  await page.waitForURL(/tab=errors/);
  await expect(panel.getByRole("table", { name: "Latest errors" }).locator(".cs-status")).toHaveText(["404", "503"]);

  const a11y = await new AxeBuilder({ page }).include(".cs").analyze();
  expect(a11y.violations).toEqual([]);
});

test("says so when there are no users, no groups, or no such user", async ({ page }) => {
  await seed({ summary: { consumers: 0, new: 0, returning: 0 }, points: [], consumers: [] });
  await signIn(page);
  await expect(page.getByRole("status").filter({ hasText: "No identified users in the last 24 hours." })).toBeVisible();
  await expect(usersTable(page)).toHaveCount(0);

  await page.goto(`${PAGE}?by=groups`);
  await expect(page.getByRole("status").filter({ hasText: "No groups reported in the last 24 hours." })).toBeVisible();

  await page.goto(`${PAGE}?consumer=nobody`);
  await expect(page.getByRole("status").filter({ hasText: "There’s no user with this id in this project." })).toBeVisible();
});

const ANONYMOUS = {
  totals: split(2843, 120, 9),
  callers: [
    { ip_address: "203.0.113.7", user_agent: "curl/8.7.1", last_seen: ago(1), ...split(2100, 100, 9) },
    { ip_address: "198.51.100.23", user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", last_seen: ago(12), ...split(743, 20, 0) },
  ],
};

async function seedApps(apps: Record<string, unknown>[]) {
  const res = await fetch(`${IDENTITY}/__fake/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apps }) });
  expect(res.status).toBe(204);
}

const report = (framework: string) => ({
  environment: "production",
  framework,
  framework_version: "1",
  runtime_version: "1",
  sdk_version: "0.1.0",
  config: {},
  received_at: ago(5),
});

test("anonymous traffic: the request count, the SDK snippets picked from the project's apps, and the top callers linking to Explore", async ({ page }) => {
  await seed({ summary: { consumers: 0, new: 0, returning: 0 }, points: [], consumers: [], anonymous: ANONYMOUS });
  await seedApps([
    { id: "11111111-1111-4111-8111-111111111111", slug: "orders", name: "Orders", environments: [report("Spring MVC")] },
    { id: "22222222-2222-4222-8222-222222222222", slug: "web", name: "Web", environments: [report("FastAPI")] },
  ]);
  try {
    await signIn(page);
    await expect(page.getByRole("status").filter({ hasText: "No identified users in the last 24 hours, but 2,843 anonymous requests arrived." })).toBeVisible();

    // Snippets: one tab per SDK the apps run, the first app's first; arrow keys switch.
    const identify = page.getByRole("region", { name: "Identify your users" });
    const tabs = identify.getByRole("tablist", { name: "SDK" }).getByRole("tab");
    await expect(tabs).toHaveText(["Spring", "Python"]);
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    const panel = identify.getByRole("tabpanel");
    await expect(panel).toContainText("ApiLensConsumers.setConsumer(user.getId(), user.getEmail(), user.getPlan());");
    await expect(panel.getByRole("link", { name: "Identifying consumers with Spring MVC" })).toHaveAttribute("href", /setup-guides\/spring-mvc#identify-consumers$/);
    await tabs.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(panel).toContainText("set_consumer(request, identifier=user.id, name=user.name, group=user.plan)");
    await expect(panel.getByRole("link", { name: "Identifying consumers with FastAPI" })).toHaveAttribute("href", /setup-guides\/fastapi#identify-consumers$/);

    // The fallback table: top callers by client IP / user agent, each IP opening Explore.
    const callers = page.getByRole("region", { name: "Top callers by client IP / user agent" });
    await expect(callers.locator("dd")).toHaveText(["2,843", "129 4.5%"]);
    const table = callers.getByRole("table");
    await expect(table.getByRole("columnheader")).toHaveText(["Client IP", "User agent", "Requests", "Errors", "Last seen"]);
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("curl/8.7.1");
    await expect(rows.first()).toContainText("2,100");
    const ip = rows.first().getByRole("link", { name: "203.0.113.7" });
    const href = new URL((await ip.getAttribute("href")) ?? "", "http://x");
    expect(href.pathname).toBe("/shop/explore");
    expect(href.searchParams.get("ip")).toBe("203.0.113.7");

    const a11y = await new AxeBuilder({ page }).include(".cs").analyze();
    expect(a11y.violations).toEqual([]);

    // Every SDK when no app reported a framework.
    await seedApps([]);
    await page.reload();
    await expect(identify.getByRole("tablist", { name: "SDK" }).getByRole("tab")).toHaveText(["Python", "Express", "Spring"]);
    await identify.getByRole("tab", { name: "Express" }).click();
    await expect(identify.getByRole("tabpanel")).toContainText("setConsumer(req, { id: req.user.id, name: req.user.email, group: req.user.plan });");

    // At phone width the callers stack, without sideways scrolling.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rows).toHaveCount(2);
    expect(await page.locator(".app-main").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  } finally {
    await seedApps([]);
  }
});

test("says so when the query API cannot answer, with a way to try again", async ({ page }) => {
  await seed();
  await queryDown(true);
  await signIn(page);
  const alert = page.getByRole("alert").filter({ hasText: "We couldn’t load consumers just now." });
  await expect(alert).toBeVisible();
  await queryDown(false);
  await alert.getByRole("link", { name: "Try again" }).click();
  await expect(usersTable(page).locator("tbody tr")).toHaveCount(3);
});

test("stacks at phone width without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed();
  await signIn(page);
  await expect(usersTable(page).locator("tbody tr")).toHaveCount(3);
  await expect(page.getByRole("navigation", { name: "Sort" })).toBeVisible();
  const overflow = () => page.locator(".app-main").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.goto(`${PAGE}?consumer=usr_1f3a9c`);
  await expect(page.getByRole("table", { name: "Latest requests" })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});
