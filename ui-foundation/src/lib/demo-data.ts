// Realistic demo data. Real copy, real shapes: never lorem ipsum, never
// "Item 1". Screens built against this should look like the product.

import type { Role } from "./capabilities";

export type Plan = "Hobby" | "Pro" | "Enterprise";

export interface Organization {
  slug: string;
  name: string;
  plan: Plan;
  role: Role;
}

export interface Project {
  slug: string;
  name: string;
  /** Display name of the owning organization. */
  org: string;
  orgSlug: string;
  role: Role;
}

export const ORGANIZATIONS: Organization[] = [
  { slug: "northwind", name: "Northwind", plan: "Pro", role: "admin" },
  { slug: "halcyon-health", name: "Halcyon Health", plan: "Enterprise", role: "member" },
  { slug: "alex-rivera", name: "Personal", plan: "Hobby", role: "owner" },
];

export const PROJECTS: Project[] = [
  { slug: "checkout-api", name: "Checkout API", org: "Northwind", orgSlug: "northwind", role: "admin" },
  { slug: "payments-gateway", name: "Payments Gateway", org: "Northwind", orgSlug: "northwind", role: "owner" },
  { slug: "partner-sync", name: "Partner Sync", org: "Northwind", orgSlug: "northwind", role: "viewer" },
  { slug: "patient-portal-api", name: "Patient Portal API", org: "Halcyon Health", orgSlug: "halcyon-health", role: "member" },
  { slug: "claims-gateway", name: "Claims Gateway", org: "Halcyon Health", orgSlug: "halcyon-health", role: "viewer" },
  { slug: "sandbox-api", name: "Sandbox API", org: "Personal", orgSlug: "alex-rivera", role: "owner" },
];

export function projectBySlug(slug: string): Project {
  return PROJECTS.find((p) => p.slug === slug) ?? PROJECTS[0];
}

export function orgBySlug(slug: string): Organization {
  return ORGANIZATIONS.find((o) => o.slug === slug) ?? ORGANIZATIONS[0];
}

export const CURRENT_USER = { name: "Alex Rivera", email: "alex@northwind.dev" };

/** Plan usage for the active org, shown quietly in the sidebar footer. */
export const USAGE: Record<string, { label: string; used: number; limit: number }> = {
  northwind: { label: "Requests this month", used: 1_445_509, limit: 2_000_000 },
  "halcyon-health": { label: "Requests this month", used: 18_204_118, limit: 20_000_000 },
  "alex-rivera": { label: "Requests this month", used: 41_220, limit: 100_000 },
};

/** Actionable counts only (unresolved new issues), never vanity numbers. */
export const NAV_COUNTS: Record<string, Partial<Record<string, number>>> = {
  "checkout-api": { errors: 12 },
  "payments-gateway": { errors: 3 },
};

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface EndpointRow {
  method: Method;
  path: string;
  requests: number;
  clientErrorRate: number;
  serverErrorRate: number;
  p95Ms: number;
  trend: number[];
}

export const ENDPOINTS: EndpointRow[] = [
  { method: "POST", path: "/v1/checkout/sessions", requests: 182_430, clientErrorRate: 0.0121, serverErrorRate: 0.0009, p95Ms: 241, trend: [42, 44, 41, 47, 52, 49, 55, 58, 54, 61, 63, 66] },
  { method: "GET", path: "/v1/products/{id}", requests: 961_204, clientErrorRate: 0.0034, serverErrorRate: 0.0001, p95Ms: 38, trend: [80, 82, 79, 85, 88, 86, 90, 93, 91, 95, 94, 97] },
  { method: "POST", path: "/v1/payments/charge", requests: 64_118, clientErrorRate: 0.0212, serverErrorRate: 0.0187, p95Ms: 1240, trend: [12, 13, 12, 14, 18, 21, 19, 24, 27, 26, 31, 34] },
  { method: "GET", path: "/v1/orders", requests: 211_902, clientErrorRate: 0.0045, serverErrorRate: 0.0006, p95Ms: 96, trend: [30, 31, 33, 32, 34, 33, 35, 36, 35, 37, 38, 37] },
  { method: "PATCH", path: "/v1/orders/{id}", requests: 18_544, clientErrorRate: 0.0388, serverErrorRate: 0, p95Ms: 132, trend: [8, 9, 8, 7, 9, 10, 9, 11, 10, 9, 10, 11] },
  { method: "DELETE", path: "/v1/carts/{id}/items/{itemId}", requests: 7_311, clientErrorRate: 0.0062, serverErrorRate: 0.0003, p95Ms: 54, trend: [3, 4, 3, 3, 4, 5, 4, 4, 5, 5, 4, 5] },
];

export const KPIS = {
  requests: { value: 1_445_509, delta: 0.124, trend: [61, 64, 62, 68, 73, 70, 76, 80, 77, 84, 86, 90] },
  clientErrors: { value: 0.0071, delta: -0.031, trend: [9, 8, 9, 8, 7, 8, 7, 7, 8, 7, 7, 7] },
  serverErrors: { value: 0.0011, delta: 0.42, trend: [2, 2, 3, 2, 3, 4, 3, 5, 6, 5, 7, 8] },
  p95: { value: 182, delta: -0.058, trend: [210, 205, 199, 201, 196, 192, 190, 188, 186, 185, 183, 182] },
};

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const now = new Date("2026-10-22T14:05:09Z");
const minus = (ms: number) => new Date(now.getTime() - ms);

export const API_KEYS: ApiKey[] = [
  { id: "key_01", name: "Production ingest", prefix: "apl_live_3f9a", createdAt: minus(86_400_000 * 41), lastUsedAt: minus(12_000) },
  { id: "key_02", name: "Staging ingest", prefix: "apl_test_b71c", createdAt: minus(86_400_000 * 12), lastUsedAt: minus(3_600_000 * 5) },
  { id: "key_03", name: "CI smoke tests", prefix: "apl_test_09de", createdAt: minus(86_400_000 * 3), lastUsedAt: null },
];

export const DEMO_NOW = now;
