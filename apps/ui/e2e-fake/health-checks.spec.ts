// Project settings → Health checks (#608) against the fake identity (e2e-fake/fake-identity.ts),
// which serves shop's apps (`GET /project`) and its health checks with their failures
// (`/projects/shop/alerts/health-checks`). No email is sent by any test here.
import { type Page, expect, test } from "@playwright/test";

const IDENTITY = "http://localhost:18080";
const HEALTH = "/shop/settings/health-checks";
const SHOP = "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const CHECK = "0b9c3a52-6a3e-4f0e-9d0b-6c2f1e7d8a41";

async function post(path: string, body: unknown) {
  await fetch(`${IDENTITY}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function signIn(page: Page) {
  const res = await fetch(`${IDENTITY}/__fake/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ next: HEALTH, capabilities: ["project.read"] }),
  });
  const { code } = (await res.json()) as { code: string };
  await page.goto(`/auth/callback?code=${code}`);
  await page.waitForURL((url) => url.pathname === HEALTH);
}

const FAILURE = {
  ok: false,
  status_code: 503,
  expected_status: 200,
  latency_ms: 41.2,
  error: "unexpected status 503",
  body_snippet: '{"status":"degraded","password":"[redacted]"}',
  body_truncated: true,
  attempts: 2,
  checked_at: "2026-11-05T09:30:00Z",
};

test.beforeEach(async () => {
  await post("/__fake/apps", { apps: [{ id: SHOP, slug: "shop", name: "Shop" }] });
  await post("/__fake/health-checks", { checks: [] });
});

test("shows a failing check with the failed request's details", async ({ page }) => {
  await post("/__fake/health-checks", {
    checks: [
      {
        id: CHECK, app_id: SHOP, environment: "production", url: "https://api.example.com/healthz", expected_status: 200, enabled: true,
        status: "down", status_since: "2026-11-05T09:30:00Z", checked_at: "2026-11-05T09:31:00Z", last_result: { ...FAILURE, checked_at: "2026-11-05T09:31:00Z" },
        created_by: null, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
      },
    ],
    events: {
      [CHECK]: [
        { id: "e1", state: "triggered", started_at: "2026-11-05T09:30:00Z", ended_at: null, notified_at: "2026-11-05T09:30:05Z", failure: FAILURE },
        {
          id: "e0", state: "resolved", started_at: "2026-11-04T08:00:00Z", ended_at: "2026-11-04T08:04:00Z", notified_at: null,
          failure: { ...FAILURE, status_code: 0, error: "timeout", body_snippet: undefined, body_truncated: false, latency_ms: 5000 },
        },
      ],
    },
  });
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Health checks", level: 1 })).toBeVisible();
  const check = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "GET https://api.example.com/healthz" }) });
  await expect(check.getByText("Failing", { exact: true })).toBeVisible();
  await expect(check).toContainText("Shop · production · expects 200");
  await expect(check).toContainText("HTTP 503, expected 200 in 41 ms");

  const failures = check.getByRole("listitem");
  await expect(failures).toHaveCount(2);
  await expect(failures.first()).toContainText("ongoing");
  await expect(failures.first()).toContainText("2 (retried once)");
  await expect(failures.first().getByText("Response body, first 1 KB, masked by the privacy policy")).toBeVisible();
  await expect(failures.first().locator("pre")).toHaveText('{"status":"degraded","password":"[redacted]"}');
  await expect(failures.nth(1)).toContainText("Timeout");
  await expect(failures.nth(1)).toContainText("5 s");
  await expect(failures.nth(1).locator("pre")).toHaveCount(0);
});

test("adds a check, refuses a private address and deletes a check", async ({ page }) => {
  await signIn(page);
  await expect(page.getByText("No health checks yet.")).toBeVisible();
  const form = page.getByRole("form", { name: "Add a check" });

  await form.getByLabel("URL").fill("http://10.0.0.5/healthz");
  await form.getByRole("button", { name: "Add check" }).click();
  await expect(form.getByRole("status")).toHaveText("Not accepted: url must point to a public address.");
  await expect(form.getByLabel("URL")).toBeFocused();

  await form.getByLabel("URL").fill("https://api.example.com/healthz");
  await form.getByRole("button", { name: "Add check" }).click();
  await expect(form.getByRole("status")).toHaveText("Added. The first probe of https://api.example.com/healthz runs within a minute.");
  await expect(page.getByRole("heading", { name: "GET https://api.example.com/healthz" })).toBeVisible();
  await expect(page.getByText("Not checked yet")).toBeVisible();

  await page.getByRole("button", { name: "Delete the check of https://api.example.com/healthz" }).click();
  await page.getByRole("button", { name: "Delete check" }).click();
  await expect(page.getByText("No health checks yet.")).toBeVisible();
});
