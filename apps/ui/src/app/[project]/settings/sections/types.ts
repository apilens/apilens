import type { ReactNode } from "react";
import type { UserContext } from "@/lib/identity";
import type { SearchParams } from "@/lib/pagination";

/** What every section's `load` and `render` get from the settings page. */
export interface SectionContext {
  /** The project slug. */
  project: string;
  projectName: string;
  context: UserContext;
  search: SearchParams;
  /** The section's own path, where a refresh comes back to. */
  next: string;
}

/** A section file's exports: `load` fetches on the server, `render` draws what it loaded. */
export interface SectionModule<T> {
  load: (ctx: SectionContext) => Promise<T>;
  render: (data: T, ctx: SectionContext) => ReactNode;
}

/** A registry entry: loads and renders one section. */
export type Section = (ctx: SectionContext) => Promise<ReactNode>;

/** Turns a section file (`import * as x from "./x"`) into a registry entry. */
export function section<T>(mod: SectionModule<T>): Section {
  return async (ctx) => mod.render(await mod.load(ctx), ctx);
}
