import { ChartSkeleton, HeaderSkeleton, StatRowSkeleton, TableSkeleton } from "@/components/loading";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <div className="flex flex-col gap-4">
        <StatRowSkeleton />
        <ChartSkeleton title="Requests over time" />
        <TableSkeleton title="Endpoints" columns={8} />
      </div>
    </>
  );
}
