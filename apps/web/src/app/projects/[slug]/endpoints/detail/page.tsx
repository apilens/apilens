import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import EndpointDetailContent from "./EndpointDetailContent";

export const metadata = {
  title: "Endpoint · APILens",
};

export default async function EndpointDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  const { slug } = await params;
  // useSearchParams (inside the content component) must be wrapped in Suspense.
  return (
    <Suspense fallback={<div className="endpoint-page-loading">Loading endpoint…</div>}>
      <EndpointDetailContent projectSlug={slug} />
    </Suspense>
  );
}
