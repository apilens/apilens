import { ComingSoonCard } from "@/components/coming-soon/coming-soon";
import type { SectionContext } from "./types";

/** Alerts aren't open yet (Incidents is coming soon too): nothing to read. */
export async function load(_: SectionContext): Promise<null> {
  return null;
}

export function render(_: null, { project }: SectionContext) {
  return (
    <div className="page page--measure cs-soon cs-soon--section">
      <ComingSoonCard
        project={project}
        heading="h2"
        title="Alert channels"
        blurb="Where alert notifications go: email, Slack, Microsoft Teams and webhooks, with a test send for each."
      />
    </div>
  );
}
