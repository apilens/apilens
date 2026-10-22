import { HeaderSkeleton, StatRowSkeleton, TableSkeleton } from "@/components/loading";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <div className="flex flex-col gap-4">
        <StatRowSkeleton />
        <TableSkeleton title="Waterfall" rows={6} columns={3} />
        <TableSkeleton title="Logs" rows={3} columns={4} />
      </div>
    </>
  );
}
