// The project settings types of identity.ts (#805) against api/openapi/apilens.v1.json: each
// fixture below is typed with every field set, so TypeScript rejects a field the type lacks and
// this test rejects a field the spec lacks or the spec has that the type leaves out.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  AppUsageTotals,
  DeletedProject,
  Environment,
  EnvironmentsList,
  ProjectDetail,
  ProjectUsage,
  QuotaUsage,
  Retention,
  RetentionSignal,
  UpdateEnvironmentRequest,
  UpdateProjectRequest,
  UsageCounts,
  UsageDay,
} from "./identity";

vi.mock("server-only", () => ({}));

interface Schema {
  properties?: Record<string, { enum?: string[] }>;
  required?: string[];
}
const spec = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../api/openapi/apilens.v1.json", import.meta.url)), "utf8"),
) as { components: { schemas: Record<string, Schema> }; paths: Record<string, Record<string, { requestBody?: unknown }>> };

const T = "2026-11-13T10:00:00Z";
const ID = "3f0e8c1a-2b4d-4e6f-8a1b-2c3d4e5f6a7b";

const project: Required<ProjectDetail> = {
  id: ID,
  slug: "shop",
  name: "Shop",
  description: "Storefront API",
  org_id: ID,
  org_slug: "acme",
  role: "admin",
  environments: ["production"],
  created_at: T,
  updated_at: T,
  created_by: ID,
  repository_url: "https://github.com/acme/shop",
  commit_url_template: "https://github.com/acme/shop/commit/{commit}",
  release_url_template: "https://github.com/acme/shop/releases/tag/{release}",
  paused_at: null,
  paused_by: null,
  canonical_slug: "shop",
};
const rename = { slug: "shop-api" };
// The slug is left out on purpose: renaming goes through `renameProject` (#794), not PATCH.
const update: Required<UpdateProjectRequest> & { slug: string } = { name: "Shop", description: "", repository_url: "", slug: "shop" };
const deleted: Required<DeletedProject> = { id: ID, slug: "shop", name: "Shop", description: "", created_at: T, deleted_at: T, purge_after: T };
const environment: Required<Environment> = {
  name: "production",
  is_production: true,
  color: "green",
  position: 0,
  hidden: false,
  hidden_at: null,
  source: "sdk",
  first_seen_at: T,
  last_seen_at: T,
  created_at: T,
  has_data: true,
  api_keys: 2,
  health_checks: 1,
  deletable: false,
};
const environments: Required<EnvironmentsList> = { environments: [environment], max_environments: 20 };
const envUpdate: Required<UpdateEnvironmentRequest> = { is_production: false, color: "none", hidden: true, position: 1 };
const signal: Required<RetentionSignal> = { key: "requests", label: "Requests", period_days: 90, covers: "Individual requests", configurable: true };
const retention: Required<Retention> = { signals: [signal] };
const counts: Required<UsageCounts> = { accepted: 1, rejected: 0, truncated: 0, masked: 0, rejected_by_reason: [] };
const day: Required<UsageDay> = { ...counts, date: "2026-11-13", bytes: 10 };
const app: Required<AppUsageTotals> = { ...counts, app_id: ID, app: "shop" };
const quota: Required<QuotaUsage> = { records_per_minute: 0, bytes_per_day: 0, bytes_today: 10, bytes_today_ratio: null, rejected_today: 0 };
const usage: Required<ProjectUsage> = {
  project: "shop",
  days: 30,
  totals: counts,
  bytes: 10,
  daily: [day],
  apps: [app],
  environments: [{ environment: "production", accepted: 1 }],
  quota,
};

const cases: [string, object][] = [
  ["Project", project],
  ["UpdateProjectInputBody", update],
  ["RenameProjectInputBody", rename],
  ["DeletedProject", deleted],
  ["Environment", environment],
  ["EnvironmentsOutputBody", environments],
  ["UpdateEnvironmentInputBody", envUpdate],
  ["RetentionSignal", signal],
  ["Retention", retention],
  ["UsageCounts", counts],
  ["UsageDay", day],
  ["AppUsageTotals", app],
  ["QuotaUsage", quota],
  ["ProjectUsage", usage],
  ["EnvironmentUsage", usage.environments![0]],
];

describe("project settings types match the committed OpenAPI spec", () => {
  it.each(cases)("%s", (name, fixture) => {
    const schema = spec.components.schemas[name];
    expect(schema, `${name} is not in the spec`).toBeDefined();
    const props = Object.keys(schema.properties ?? {}).filter((p) => p !== "$schema").sort();
    expect(Object.keys(fixture).sort()).toEqual(props);
  });

  it("keeps the environment palette and retention signals of the spec", () => {
    const palette: Environment["color"][] = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple"];
    expect(spec.components.schemas.UpdateEnvironmentInputBody.properties?.color.enum).toEqual([...palette, "none"]);
    const keys: RetentionSignal["key"][] = ["requests", "logs", "spans", "rollups_1m", "rollups_1h", "deploys"];
    expect(spec.components.schemas.RetentionSignal.properties?.key.enum).toEqual(keys);
  });

  it("sends the add, reorder and delete bodies the spec names", () => {
    const props = (name: string) => Object.keys(spec.components.schemas[name].properties ?? {}).filter((p) => p !== "$schema");
    expect(props("AddEnvironmentInputBody")).toEqual(["name"]);
    expect(props("ReorderEnvironmentsInputBody")).toEqual(["names"]);
    expect(props("DeleteProjectBody")).toEqual(["confirm"]);
  });
});
