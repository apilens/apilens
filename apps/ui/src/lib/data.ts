// Sample tenancy and data. Names, health and facts follow the design system's own examples.

export type Health = "ok" | "warn" | "error" | "info" | "none";

export interface Org {
  slug: string;
  name: string;
  mark: string;
  role: string;
  note: string;
  health: Health;
  fact: string;
}
export interface Project {
  slug: string;
  name: string;
  org: string;
  health: Health;
  services: number;
}
export interface Service {
  slug: string;
  project: string;
  health: Health;
  fact: string;
}

export const ORGS: Org[] = [
  { slug: "acme-retail", name: "Acme Retail", mark: "A", role: "Owner", note: "4 projects", health: "warn", fact: "2" },
  { slug: "acme-labs", name: "Acme Labs", mark: "L", role: "Admin", note: "3 projects", health: "ok", fact: "quiet" },
  { slug: "northwind", name: "Northwind", mark: "N", role: "Admin", note: "client org", health: "info", fact: "client" },
  { slug: "sandbox", name: "Sandbox", mark: "S", role: "Owner", note: "1 project", health: "none", fact: "idle 9d" },
];

export const PROJECTS: Project[] = [
  { slug: "platform", name: "platform", org: "acme-retail", health: "warn", services: 5 },
  { slug: "identity", name: "identity", org: "acme-retail", health: "none", services: 3 },
  { slug: "storefront", name: "storefront", org: "acme-retail", health: "info", services: 4 },
  { slug: "notifications", name: "notifications", org: "acme-retail", health: "none", services: 2 },
  { slug: "ml-gateway", name: "ml-gateway", org: "acme-labs", health: "ok", services: 3 },
  { slug: "orders", name: "orders", org: "northwind", health: "info", services: 4 },
  { slug: "scratch", name: "scratch", org: "sandbox", health: "none", services: 1 },
];

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

export const PINNED = [
  { slug: "web-api", health: "warn" as Health, value: "412 ms", tone: "warn" },
  { slug: "jobs-worker", health: "error" as Health, value: "6.1%", tone: "error" },
  { slug: "users-db", health: "none" as Health, value: "4 ms", tone: "none" },
];

export const USER = { name: "Amit", initials: "AM", email: "amit@motadata.com" };
export const USAGE = { pct: 60, text: "29.8 of 50 GB · resets Nov 1" };

export const VIEWS = [
  { slug: "incidents", label: "Incidents", section: "Monitor", badge: "1", warn: true },
  { slug: "explore", label: "Explore", section: "Monitor" },
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

export const orgOf = (p: Project) => ORGS.find((o) => o.slug === p.org)!;
export const projectBySlug = (slug: string) => PROJECTS.find((p) => p.slug === slug);

export const firstProjectOf = (orgSlug: string) => PROJECTS.find((p) => p.org === orgSlug) ?? PROJECTS[0];
export const orgBySlug = (slug: string) => ORGS.find((o) => o.slug === slug) ?? ORGS[0];

// ── Apps: the services instrumented in a project ───────────────────────────
export type Lang = "python" | "java" | "go" | "node";
export type AppStatus = "reporting" | "stale" | "silent";
export interface AppInfo {
  slug: string;
  project: string;
  health: Health;
  lang: Lang;
  runtime: string;
  sdk: { name: string; version: string; latest: string };
  status: AppStatus;
  lastSeen: string;
  envs: string[];
  sampling: number;
  otel: boolean;
  captures: { traces: boolean; payloads: boolean; exceptions: boolean };
  rpm: number;
  p95: number;
  errorRate: number;
  version: string;
  deployedAgo: string;
}

const SDK: Record<Lang, { name: string; latest: string; runtimes: string[] }> = {
  python: { name: "apilens-python", latest: "0.4.0", runtimes: ["Python 3.12", "Python 3.11"] },
  java: { name: "apilens-java", latest: "1.3.0", runtimes: ["JVM 21", "JVM 17"] },
  go: { name: "apilens-go", latest: "0.9.2", runtimes: ["Go 1.23"] },
  node: { name: "apilens-node", latest: "2.1.0", runtimes: ["Node 22"] },
};
const LANGS: Lang[] = ["python", "java", "python", "go", "java", "node", "python"];
const OLD: Record<Lang, string> = { python: "0.3.2", java: "1.2.1", go: "0.8.0", node: "1.9.4" };

/** Deterministic sample instrumentation for every service, so every project has realistic apps. */
export const APPS: AppInfo[] = SERVICES.map((s, i) => {
  const lang = LANGS[i % LANGS.length];
  const sdk = SDK[lang];
  const silent = s.slug === "fraud-score" || s.slug === "demo-api";
  const stale = s.slug === "ledger-db" || s.slug === "push-svc";
  const outdated = i % 4 === 1;
  return {
    slug: s.slug,
    project: s.project,
    health: s.health,
    lang,
    runtime: sdk.runtimes[i % sdk.runtimes.length],
    sdk: { name: sdk.name, version: outdated ? OLD[lang] : sdk.latest, latest: sdk.latest },
    status: silent ? "silent" : stale ? "stale" : "reporting",
    lastSeen: silent ? (s.slug === "demo-api" ? "9 days ago" : "2 days ago") : stale ? "18 min ago" : `${(i * 7) % 50 + 2}s ago`,
    envs: i % 3 === 0 ? ["production", "staging"] : ["production"],
    sampling: [1, 0.5, 1, 0.25, 1, 0.1][i % 6],
    otel: i % 5 !== 3,
    captures: { traces: true, payloads: i % 3 !== 2, exceptions: true },
    rpm: silent ? 0 : 180 + ((i * 397) % 2400),
    p95: s.fact.endsWith("ms") ? parseInt(s.fact) : 40 + ((i * 53) % 260),
    errorRate: s.health === "error" ? 0.061 : s.health === "warn" ? 0.012 : ((i * 13) % 9) / 1000,
    version: `v2.${(i * 3) % 9}.${i % 4}`,
    deployedAgo: ["2 h ago", "1 day ago", "3 days ago", "40 min ago", "6 days ago"][i % 5],
  };
});
export const appsIn = (projectSlug: string) => APPS.filter((a) => a.project === projectSlug);
export const appBySlug = (projectSlug: string, slug: string) => APPS.find((a) => a.project === projectSlug && a.slug === slug);
/** An app needs attention when it stopped reporting or runs an outdated SDK. */
export const needsAttention = (a: AppInfo) => a.status !== "reporting" || a.sdk.version !== a.sdk.latest;
export const LANG_BADGE: Record<Lang, string> = { python: "PY", java: "JAVA", go: "GO", node: "NODE" };
