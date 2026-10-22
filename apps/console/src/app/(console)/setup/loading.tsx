import { HeaderSkeleton } from "@/components/loading";
import { Skeleton } from "@/components/page";
import { Panel, PanelHeader } from "@/components/panel";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <div className="flex max-w-3xl flex-col gap-4">
        {["1. Get an ingest key", "2. Pick the app", "3. Instrument it"].map((t) => (
          <Panel key={t}>
            <PanelHeader title={t} />
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-8 w-full rounded-md" />
            </div>
          </Panel>
        ))}
      </div>
    </>
  );
}
