import type { Metadata } from "next";
import { ComingSoonPage } from "@/components/coming-soon/coming-soon";

export const metadata: Metadata = { title: "Performance" };

// Performance: not open yet; the section shows a Coming soon note.
export default async function PerformancePage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return <ComingSoonPage project={project} view="performance" title="Performance" blurb="Response time by endpoint, Apdex against your thresholds, and the slowest requests to start from." />;
}
