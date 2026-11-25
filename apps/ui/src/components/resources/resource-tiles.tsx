import { type ResourceTile, resourceTiles, resourcesHref } from "@/lib/resources";
import type { AppStatus } from "@/lib/identity";
import { Sparkline } from "../traffic/charts";
import "./resources.css";

/**
 * The Overview's CPU and memory tiles (M7 #1134): the p95 over the live instances' last hour, each
 * opening the Resources tab, with a warning above 80% of the limit (said in words, not only tint).
 * Hidden when no instance has reported resources.
 */
export function ResourceTiles({ project, app, status }: { project: string; app: string; status: AppStatus | null }) {
  const { cpu, mem } = resourceTiles(status);
  if (!cpu && !mem) return null;
  return (
    <section aria-labelledby="ap-d-resources">
      <h2 id="ap-d-resources" className="ap-d-h">
        Resources, last hour
      </h2>
      <dl className="rs-tiles">
        {cpu ? <Tile label="CPU" tile={cpu} href={resourcesHref(project, app, { range: "1h" })} top={100} /> : null}
        {mem ? <Tile label="Memory" tile={mem} href={resourcesHref(project, app, { range: "1h" })} top={mem.share !== null ? 1 : undefined} /> : null}
      </dl>
    </section>
  );
}

function Tile({ label, tile, href, top }: { label: string; tile: ResourceTile; href: string; top?: number }) {
  return (
    <div className={`rs-tile${tile.warn ? " rs-tile--warn" : ""}`}>
      <dt>
        <a href={href}>{label}</a>
      </dt>
      <dd>
        <span className="tr-tile__value">{tile.value}</span>
        <span className="tr-tile__sub">{tile.sub}</span>
        {tile.warn ? <span className="rs-warn">Above 80% of the limit</span> : null}
        <Sparkline values={tile.spark} top={top} />
      </dd>
    </div>
  );
}
