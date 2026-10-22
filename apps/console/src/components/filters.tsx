import type { Range } from "@/lib/api";
import { hrefWith, RANGES } from "@/lib/params";
import { EnvSelect } from "./client";
import { Segmented } from "./page";

/** Page-level filters, in Aperture order: filters → range. */
export function Filters({
  pathname,
  current,
  envs,
}: {
  pathname: string;
  current: { range: Range; env?: string } & Record<string, string | undefined>;
  envs: string[];
}) {
  const { env, ...keep } = current;
  return (
    <>
      <EnvSelect envs={envs} value={env} keep={keep} />
      <Segmented
        label="Time range"
        items={RANGES.map((r) => ({
          key: r.value,
          label: r.label,
          href: hrefWith(pathname, current, { range: r.value }),
          active: r.value === current.range,
        }))}
      />
    </>
  );
}
