import type { Metadata } from "next";
import { ComingSoonPage } from "@/components/coming-soon/coming-soon";

export const metadata: Metadata = { title: "Deploys" };

// Deploys: not open yet; the section shows a Coming soon note.
export default async function DeploysPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return <ComingSoonPage project={project} view="deploys" title="Deploys" blurb="Every release your apps report, and what changed with it: errors, latency and traffic before and after." />;
}
