import { HeaderSkeleton, TableSkeleton } from "@/components/loading";
import { Skeleton } from "@/components/page";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <Skeleton className="mb-3 h-8 w-60 rounded-md" />
      <TableSkeleton title="Request log" rows={12} columns={8} />
    </>
  );
}
