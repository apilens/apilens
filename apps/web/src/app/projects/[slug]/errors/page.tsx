import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import ErrorsContent from "./ErrorsContent";

export const metadata = {
  title: "Errors | APILens",
};

export default async function ProjectErrorsPage({
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
    <ErrorsContent
      projectSlug={slug}
      initialFilters={{
        range: one(sp.range),
        since: one(sp.since),
        until: one(sp.until),
        env: one(sp.env),
        filter: one(sp.filter),
      }}
    />
  );
}
