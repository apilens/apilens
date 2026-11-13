// The Access › Members list (#806): who can reach a project and why (#753 D3). The server sends
// every person with access; the list is searched, filtered (`?role=`, `?source=`) and paged
// (`?page=&per=`) in the browser with all of it in the URL. Pure; safe in Client and Server
// Components alike. Unit-tested in access-members.test.ts.

import type { AccessMember, AccessSource, AccessSourceKind, DefaultAccess, ProjectRole } from "./identity";
import { matchesQuery } from "./list-search";
import { formatLastUsed } from "./passkey-settings";
import type { ParamsInput } from "./pagination";
import { DEFAULT_ACCESS_DESCRIPTIONS, PROJECT_ROLES, ROLE_LABELS } from "./project-access";

/** The URL keys of the two filters. */
export const ROLE_PARAM = "role";
export const SOURCE_PARAM = "source";

/** The source filter's options, in the order the list shows sources. */
export const SOURCE_KINDS: readonly AccessSourceKind[] = ["org_role", "default", "direct"];

/** The source filter's option labels. */
export const SOURCE_FILTER_LABELS: Record<AccessSourceKind, string> = {
  org_role: "Organization owner or admin",
  default: "Project default",
  direct: "Added to this project",
};

/** The filters the URL names; an unknown value is no filter. */
export interface MemberFilters {
  role: ProjectRole | null;
  source: AccessSourceKind | null;
}

const first = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v[0] : (v ?? undefined));
const get = (params: ParamsInput, key: string) => (params instanceof URLSearchParams ? (params.get(key) ?? undefined) : first(params[key]));

/** `?role=&source=` as the list applies them. */
export function parseMemberFilters(params: ParamsInput): MemberFilters {
  const role = get(params, ROLE_PARAM);
  const source = get(params, SOURCE_PARAM);
  return {
    role: role && (PROJECT_ROLES as readonly string[]).includes(role) ? (role as ProjectRole) : null,
    source: source && (SOURCE_KINDS as readonly string[]).includes(source) ? (source as AccessSourceKind) : null,
  };
}

/** The people that match the search (name or email) and both filters, in their order. */
export function filterMembers(members: readonly AccessMember[], query: string, filters: MemberFilters): AccessMember[] {
  return members.filter(
    (m) =>
      matchesQuery(query, [m.name, m.email]) &&
      (!filters.role || m.effective_role === filters.role) &&
      (!filters.source || (m.sources ?? []).some((s) => s.kind === filters.source)),
  );
}

const ORG_ROLE_WORD = { owner: "owner", admin: "admin", member: "member", viewer: "viewer" } as const;

/**
 * One source in words: "Organization owner", "Organization member (project default)", "Added to
 * this project".
 */
export function sourceText(source: AccessSource): string {
  switch (source.kind) {
    case "org_role":
      return source.org_role ? `Organization ${ORG_ROLE_WORD[source.org_role]}` : "Organization role";
    case "default":
      return source.org_role ? `Organization ${ORG_ROLE_WORD[source.org_role]} (project default)` : "Project default";
    case "direct":
      return "Added to this project";
  }
}

/** One line of the Source cell: the source in words and, when there are several, the role it gives. */
export interface SourceLine {
  kind: AccessSourceKind;
  text: string;
  /** The role this source grants; absent when it is the only source (the Role column says it). */
  role?: string;
}

const ORDER: Record<AccessSourceKind, number> = { org_role: 0, default: 1, direct: 2 };

/** Every source of a person, organization first, then the default, then a direct grant. */
export function sourceLines(member: Pick<AccessMember, "sources">): SourceLine[] {
  const sources = [...(member.sources ?? [])].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  const many = sources.length > 1;
  return sources.map((s) => ({ kind: s.kind, text: sourceText(s), ...(many ? { role: ROLE_LABELS[s.role] } : {}) }));
}

/** How many people hold each effective role. */
export function roleCounts(members: readonly Pick<AccessMember, "effective_role">[]): Record<ProjectRole, number> {
  const out: Record<ProjectRole, number> = { admin: 0, editor: 0, viewer: 0 };
  for (const m of members) if (Object.hasOwn(out, m.effective_role)) out[m.effective_role] += 1;
  return out;
}

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;

/**
 * The line above the table: `9 people with access: 4 Admins, 2 Editors, 3 Viewers.` (roles nobody
 * holds are left out).
 */
export function accessSummary(members: readonly Pick<AccessMember, "effective_role">[]): string {
  const counts = roleCounts(members);
  const people = members.length === 1 ? "1 person has access" : `${members.length.toLocaleString("en-US")} people have access`;
  const parts = PROJECT_ROLES.filter((r) => counts[r] > 0).map((r) => plural(counts[r], ROLE_LABELS[r]));
  return parts.length ? `${people}: ${parts.join(", ")}.` : `${people}.`;
}

/** The default access in words, for the summary: "Default access: everyone in the organization can view." */
export function defaultAccessText(def: DefaultAccess): string {
  const d = DEFAULT_ACCESS_DESCRIPTIONS[def];
  return `Default access: ${d.charAt(0).toLowerCase()}${d.slice(1)}`;
}

/** Whether nobody was added to a restricted project: only org owners and admins can reach it. */
export function isRestrictedAndEmpty(def: DefaultAccess, members: readonly Pick<AccessMember, "sources">[]): boolean {
  return def === "none" && !members.some((m) => (m.sources ?? []).some((s) => s.kind !== "org_role"));
}

/** "Never signed in", "Today", "Yesterday", "5 days ago", or the day for anything older than a month. */
export function lastActive(iso: string | null, now = Date.now()): string {
  return iso ? formatLastUsed(iso, now) : "Never signed in";
}

/** Who granted the direct role, or a dash when nobody did (or their account is gone). */
export function addedBy(member: Pick<AccessMember, "direct_role" | "added_by">): string {
  if (member.direct_role && member.added_by?.name) return member.added_by.name;
  return "—";
}

/** The count line while searching or filtering: `3 of 9 people match`. Empty without a search or filter. */
export function matchLine(shown: number, total: number, query: string, filters: MemberFilters): string {
  if (!query.trim() && !filters.role && !filters.source) return "";
  return `${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${total === 1 ? "person" : "people"} match`;
}
