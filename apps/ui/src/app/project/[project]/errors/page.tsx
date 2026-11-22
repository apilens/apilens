import type { Metadata } from "next";
import { ComingSoonPage } from "@/components/coming-soon/coming-soon";

export const metadata: Metadata = { title: "Errors" };

// Errors: not open yet; the section shows a Coming soon note.
export default async function ErrorsPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return <ComingSoonPage project={project} view="errors" title="Errors" blurb="Exceptions grouped into issues, with their stack traces, the requests that raised them and the consumers they hit." />;
}
