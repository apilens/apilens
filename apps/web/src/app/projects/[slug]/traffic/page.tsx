import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import TrafficContent from "./TrafficContent";

export const metadata = {
  title: "Traffic | APILens",
};

export default async function ProjectTrafficPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }

  const { slug } = await params;
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  return (
    <TrafficContent
      projectSlug={slug}
      initialFilters={{
        range: one(sp.range),
        since: one(sp.since),
        until: one(sp.until),
        apps: one(sp.apps),
        env: one(sp.env),
        metric: one(sp.metric),
        sort: one(sp.sort),
        consumer: one(sp.consumer),
        filter: one(sp.filter),
      }}
    />
  );
}
