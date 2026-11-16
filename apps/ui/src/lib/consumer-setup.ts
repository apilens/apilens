// Consumers when traffic is anonymous (#989): the SDK snippets that set the consumer (and its
// group) on each request, one tab per SDK the project's apps run (all three when none reported
// yet), the docs section each follows, and the Explore link of a top anonymous caller. Pure; safe
// in Client Components; unit-tested in consumer-setup.test.ts.
import type { QueryRange } from "./identity";
import type { Snippet } from "./install";
import { exploreHref } from "./explore";
import { NO_FILTERS } from "./explore-filters";

export type ConsumerSdk = "python" | "express" | "spring";

export interface ConsumerSdkTab {
  id: ConsumerSdk;
  label: string;
  /** The framework the snippet and its docs guide are written for. */
  framework: string;
  /** The docs setup guide (apps/docs/setup-guides) whose "Identify consumers" section the snippet follows. */
  guide: string;
}

/** The SDKs with a consumer snippet, in onboarding's order. */
export const CONSUMER_SDKS: readonly ConsumerSdkTab[] = [
  { id: "python", label: "Python", framework: "FastAPI", guide: "setup-guides/fastapi" },
  { id: "express", label: "Express", framework: "Express", guide: "setup-guides/express" },
  { id: "spring", label: "Spring", framework: "Spring MVC", guide: "setup-guides/spring-mvc" },
];

const SNIPPETS: Record<ConsumerSdk, string> = {
  python: `from fastapi import Depends, FastAPI, Request
from apilens.fastapi import set_consumer

# Runs after your auth resolved the user: a stable id, a display name, and the
# company or plan the user belongs to as the group.
async def identify_consumer(request: Request, user=Depends(get_current_user)):
    set_consumer(request, identifier=user.id, name=user.name, group=user.plan)

app = FastAPI(dependencies=[Depends(identify_consumer)])`,
  express: `import { setConsumer } from "apilens-js-sdk";

// After your auth middleware: a stable id, a display name, and the company or
// plan the user belongs to as the group.
app.use((req, res, next) => {
  if (req.user) {
    setConsumer(req, { id: req.user.id, name: req.user.email, group: req.user.plan });
  }
  next();
});`,
  spring: `import ai.apilens.ApiLensConsumers;

// Once your auth knows the user: a stable id, a display name, and the company or
// plan the user belongs to as the group. Cleared after each request.
@GetMapping("/orders/{id}")
Order order(@PathVariable("id") String id, @AuthenticationPrincipal User user) {
  ApiLensConsumers.setConsumer(user.getId(), user.getEmail(), user.getPlan());
  return orders.find(id);
}`,
};

/** The code that sets the consumer and its group on each request with `sdk`. */
export function consumerSnippet(sdk: ConsumerSdk): Snippet {
  const tab = CONSUMER_SDKS.find((t) => t.id === sdk) ?? CONSUMER_SDKS[0];
  return { id: `consumer-${tab.id}`, title: `${tab.framework}: set the consumer`, code: SNIPPETS[tab.id] };
}

/** The "Identify consumers" section of `sdk`'s setup guide under the docs root `docs`. */
export function consumerDocsUrl(docs: string, sdk: ConsumerSdk): string {
  const tab = CONSUMER_SDKS.find((t) => t.id === sdk) ?? CONSUMER_SDKS[0];
  return `${docs.replace(/\/+$/, "")}/${tab.guide}#identify-consumers`;
}

const PYTHON = ["fastapi", "flask", "django", "starlette", "litestar", "blacksheep", "python"];
const NODE = ["express", "fastify", "nest", "koa", "hono", "node"];

/** The SDK tab for a framework an app's SDK reported (`FastAPI`, `Express`, `Spring MVC`), or null. */
export function sdkForFramework(framework: string): ConsumerSdk | null {
  const f = framework.trim().toLowerCase();
  if (!f) return null;
  if (f.includes("spring") || f.includes("java")) return "spring";
  if (NODE.some((n) => f.includes(n))) return "express";
  if (PYTHON.some((n) => f.includes(n))) return "python";
  return null;
}

/**
 * The tabs to show for the frameworks the project's apps reported: the SDKs they run, in the order
 * first reported; every SDK when none is known (no app reported yet, or only unknown frameworks).
 */
export function pickConsumerSdks(frameworks: readonly string[]): ConsumerSdk[] {
  const picked: ConsumerSdk[] = [];
  for (const f of frameworks) {
    const sdk = sdkForFramework(f);
    if (sdk && !picked.includes(sdk)) picked.push(sdk);
  }
  return picked.length ? picked : CONSUMER_SDKS.map((t) => t.id);
}

/** Explore's request log narrowed to one client IP, in the range. */
export function exploreIpHref(project: string, range: QueryRange, ip: string): string {
  return exploreHref(project, { range, filters: { ...NO_FILTERS, ip } });
}
