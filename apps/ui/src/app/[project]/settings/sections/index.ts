// The project settings sections that have content, by slug (#800). Adding a section: write
// `sections/<slug>.tsx` exporting `load` and `render`, then add one line here. A section listed
// in `lib/project-settings.ts` without an entry here shows "Nothing here yet".
import * as alerts from "./alerts";
import * as capture from "./capture";
import * as healthChecks from "./health-checks";
import * as ingest from "./ingest";
import * as integrations from "./integrations";
import * as privacy from "./privacy";
import * as sdk from "./sdk";
import { type Section, section } from "./types";
import * as usage from "./usage";

export const SECTION_CONTENT: Readonly<Record<string, Section>> = {
  sdk: section(sdk),
  capture: section(capture),
  privacy: section(privacy),
  ingest: section(ingest),
  usage: section(usage),
  alerts: section(alerts),
  "health-checks": section(healthChecks),
  integrations: section(integrations),
};
