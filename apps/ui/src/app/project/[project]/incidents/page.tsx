import type { Metadata } from "next";
import { ComingSoonPage } from "@/components/coming-soon/coming-soon";

export const metadata: Metadata = { title: "Incidents" };

// Incidents: not open yet; the section shows a Coming soon note.
export default async function IncidentsPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return <ComingSoonPage project={project} view="incidents" title="Incidents" blurb="Alert rules on your error rate, latency and traffic, and the incidents they open, with who was affected and when it recovered." />;
}
