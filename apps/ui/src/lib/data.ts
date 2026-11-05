// View definitions (`VIEWS`, `SECTIONS`, settings pages). Tenancy (user, orgs, projects, roles)
// is real: it comes from `GET /users/me/context` via `lib/auth/server.ts` and `lib/scope.ts`.
// The services below (the top bar's service picker) are still sample data, keyed by sample project
// slugs. Apps are real: the Apps overview (#591) reads them from `GET /project` and `/apps/{id}/status`.

export type Health = "ok" | "warn" | "error" | "info" | "none";

export interface Service {
  slug: string;
  project: string;
  health: Health;
  fact: string;
}

export const SERVICES: Service[] = [
  { slug: "checkout-api", project: "platform", health: "warn", fact: "412ms" },
  { slug: "charges-svc", project: "platform", health: "warn", fact: "388ms" },
  { slug: "refunds-worker", project: "platform", health: "error", fact: "6% 5xx" },
  { slug: "ledger-db", project: "platform", health: "ok", fact: "quiet" },
  { slug: "fraud-score", project: "platform", health: "ok", fact: "quiet" },
  { slug: "auth-api", project: "identity", health: "ok", fact: "quiet" },
  { slug: "sessions-svc", project: "identity", health: "ok", fact: "quiet" },
  { slug: "mfa-worker", project: "identity", health: "ok", fact: "quiet" },
  { slug: "web-bff", project: "storefront", health: "info", fact: "deploying" },
  { slug: "catalog-api", project: "storefront", health: "ok", fact: "quiet" },
  { slug: "cart-svc", project: "storefront", health: "ok", fact: "quiet" },
  { slug: "search-svc", project: "storefront", health: "ok", fact: "quiet" },
  { slug: "email-worker", project: "notifications", health: "ok", fact: "quiet" },
  { slug: "push-svc", project: "notifications", health: "ok", fact: "quiet" },
  { slug: "inference-api", project: "ml-gateway", health: "ok", fact: "quiet" },
  { slug: "model-registry", project: "ml-gateway", health: "ok", fact: "quiet" },
  { slug: "feature-store", project: "ml-gateway", health: "ok", fact: "quiet" },
  { slug: "orders-api", project: "orders", health: "info", fact: "client" },
  { slug: "invoices-svc", project: "orders", health: "ok", fact: "quiet" },
  { slug: "returns-svc", project: "orders", health: "ok", fact: "quiet" },
  { slug: "shipping-svc", project: "orders", health: "ok", fact: "quiet" },
  { slug: "demo-api", project: "scratch", health: "none", fact: "idle 9d" },
];

export const VIEWS = [
  { slug: "incidents", label: "Incidents", section: "Monitor", badge: "1", warn: true },
  { slug: "explore", label: "Explore", section: "Monitor" },
  { slug: "traffic", label: "Traffic", section: "Monitor" },
  { slug: "errors", label: "Errors", section: "Monitor" },
  { slug: "performance", label: "Performance", section: "Monitor" },
  { slug: "consumers", label: "Consumers", section: "Monitor" },
  { slug: "apps", label: "Apps", section: "Catalog" },
  { slug: "changes", label: "Changes", section: "Catalog" },
  { slug: "access", label: "Access", section: "Configure" },
] as const;
/** Where a project opens. */
export const HOME_VIEW = "incidents";
export const SECTIONS = ["Monitor", "Catalog", "Configure"] as const;
export type Section = (typeof SECTIONS)[number];
/** Primary rail areas (Sentry-style): icon + short label; each opens its first page. */
export const appsOf = (projectSlug: string) => SERVICES.filter((s) => s.project === projectSlug);
/** Project-level page, linked from the sidebar: /<project>/settings. */
export const PROJECT_SETTINGS = { slug: "settings", label: "Project settings", crumb: "Settings" } as const;

/** Organization-level page (not a project view): linked from the sidebar, lives at /orgs/<org>/settings. */
export const ORG_SETTINGS = { label: "Organization settings", crumb: "Settings" } as const;
export type ViewSlug = (typeof VIEWS)[number]["slug"];
