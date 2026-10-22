import { HeaderSkeleton, TableSkeleton } from "@/components/loading";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <div className="flex flex-col gap-4">
        <TableSkeleton title="Server errors" rows={4} columns={6} />
        <TableSkeleton title="Client errors" rows={4} columns={6} />
      </div>
    </>
  );
}
