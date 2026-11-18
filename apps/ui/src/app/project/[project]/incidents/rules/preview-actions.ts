"use server";

// The rule editor's preview (#982): the last 24 hours of one app's traffic in one environment, as
// the signed-in user may read it. A Server Action is a public POST endpoint, so the input is
// re-checked; a failure answers a sentence, never a raw error.
import { isProjectSlug } from "@/lib/api-keys";
import { type TrafficPoint, identity, isApiError } from "@/lib/identity";
import { PREVIEW_RANGE } from "@/lib/rule-preview";
import { withActionSession } from "@/lib/server-session";

export type PreviewResult = { ok: true; bucket_seconds: number; points: TrafficPoint[] } | { ok: false; error: string };

const PREVIEW_FAILED = "We couldn’t load the last 24 hours for the preview just now.";
const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

export async function loadRulePreview(project: unknown, app: unknown, env: unknown): Promise<PreviewResult> {
  const appId = str(app, 64);
  if (!isProjectSlug(project) || appId === null) return { ok: false, error: PREVIEW_FAILED };
  const environment = str(typeof env === "string" ? env.trim() : env, 64) ?? "";
  return withActionSession(async (s) => {
    try {
      const ts = await s.call((o) => identity().trafficTimeseries(project, { range: PREVIEW_RANGE, app: appId, env: environment }, o));
      return { ok: true as const, bucket_seconds: ts.bucket_seconds, points: ts.points ?? [] };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false as const, error: PREVIEW_FAILED };
    }
  });
}
