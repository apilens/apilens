"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { ListSearch, useCanonicalPage, useListSearch } from "@/components/list-search/list-search";
import { Pagination } from "@/components/pagination/pagination";
import {
  ROLE_PARAM,
  SOURCE_FILTER_LABELS,
  SOURCE_KINDS,
  SOURCE_PARAM,
  accessSummary,
  addedBy,
  defaultAccessText,
  filterMembers,
  isRestrictedAndEmpty,
  lastActive,
  matchLine,
  parseMemberFilters,
  sourceLines,
} from "@/lib/access-members";
import type { Candidate } from "@/lib/access-changes";
import type { AccessMember, DefaultAccess } from "@/lib/identity";
import { formatJoined } from "@/lib/org-members";
import { type SearchParams, hrefWithoutPage, parsePage, slicePage } from "@/lib/pagination";
import { PROJECT_ROLES, ROLE_LABELS } from "@/lib/project-access";
import "../org-settings/org-settings.css";
import "../org-settings/members.css";
import { type Announce, AddPeople, MemberRowMenu } from "./manage";
import "./members.css";

/** The Members tab's title and tabs, around the list (or its skeleton while it loads). */
export function MembersFrame({ projectName, nav, badge, children }: { projectName: string; nav: ReactNode; badge?: ReactNode; children: ReactNode }) {
  return (
    <div className="page os om am">
      <header className="os-head">
        <p className="cp-h">
          {projectName} · Access{badge}
        </p>
        <h1 className="cp-lede">Members</h1>
        {nav}
      </header>
      {children}
    </div>
  );
}

/** Placeholder rows while the list loads. */
export function AccessMembersLoading() {
  return (
    <div className="am-loading" aria-busy="true" aria-live="polite">
      <p className="sr-only">Loading the people with access…</p>
      <span className="am-bone am-bone--line" aria-hidden="true" />
      <div className="om-wrap" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="am-bone-row">
            <span className="am-bone am-bone--av" />
            <span className="am-bone am-bone--name" />
            <span className="am-bone am-bone--cell" />
            <span className="am-bone am-bone--cell" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * `/<project>/access` (#806): everyone who can reach the project, their effective role, where it
 * comes from (one line per source), when they were last active and who added them. Searched by name
 * or email, filtered by role and source, and paged, with `?q=&role=&source=&page=&per=` in the URL.
 * Everyone who sees the project sees the same list; holders of `access.manage` add people and
 * change or remove direct roles (#807), everyone else sees those controls disabled with the reason.
 * `data` is null when the API could not answer; `candidates` (the org members "Add people" offers)
 * is null when they could not be loaded; `now` is the server's clock so the first render matches.
 */
export function AccessMembers({
  project,
  projectName,
  data,
  params,
  now,
  candidates = null,
}: {
  project: string;
  projectName: string;
  data: { defaultAccess: DefaultAccess; members: AccessMember[] } | null;
  params: SearchParams;
  now: number;
  candidates?: Candidate[] | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const announce: Announce = setStatus;
  const pathname = `/${project}/access`;
  const list = useListSearch(pathname, params);
  const filters = parseMemberFilters(list.params);
  const members = data?.members ?? [];
  const matched = filterMembers(members, list.query, filters);
  const { rows, window } = slicePage(matched, parsePage(list.params));
  useCanonicalPage(pathname, params, data && list.settled ? window : null);

  if (!data) {
    return (
      <p className="os-note am-err" role="alert">
        Couldn’t load the people with access to {projectName}. Reload the page to try again.
      </p>
    );
  }

  const setFilter = (key: string, value: string) => router.replace(hrefWithoutPage(pathname, list.params, { [key]: value }), { scroll: false });
  const filtered = list.query.trim() !== "" || filters.role !== null || filters.source !== null;
  const match = matchLine(matched.length, members.length, list.query, filters);

  return (
    <>
      <div className="am-summary">
        <p className="am-summary__count">{accessSummary(members)}</p>
        <p className="am-summary__def">{defaultAccessText(data.defaultAccess)}</p>
      </div>

      {isRestrictedAndEmpty(data.defaultAccess, members) ? (
        <div className="os-note am-empty" role="note">
          <div>
            <p className="am-empty__t">Nobody has been added to {projectName}</p>
            <p className="am-empty__p">
              {projectName} is restricted: only organization owners and admins can open it. People added to this project will be listed here with the role they were given.
            </p>
          </div>
        </div>
      ) : null}

      <div className="om-bar am-bar">
        <ListSearch value={list.query} onChange={list.setQuery} label="Search people" placeholder="Search by name or email" controls="am-list" />
        <span className="am-filter">
          <label className="am-filter__l" htmlFor="am-role">
            Role
          </label>
          <select id="am-role" className="om-select" value={filters.role ?? ""} onChange={(e) => setFilter(ROLE_PARAM, e.target.value)}>
            <option value="">All roles</option>
            {PROJECT_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </span>
        <span className="am-filter">
          <label className="am-filter__l" htmlFor="am-source">
            Source
          </label>
          <select id="am-source" className="om-select" value={filters.source ?? ""} onChange={(e) => setFilter(SOURCE_PARAM, e.target.value)}>
            <option value="">All sources</option>
            {SOURCE_KINDS.map((s) => (
              <option key={s} value={s}>
                {SOURCE_FILTER_LABELS[s]}
              </option>
            ))}
          </select>
        </span>
        <p className="om-count am-match" role="status" aria-live="polite">
          {match}
        </p>
        <AddPeople project={project} projectName={projectName} candidates={candidates} announce={announce} />
      </div>
      <p className={`om-status am-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
        {status?.text ?? ""}
      </p>

      {matched.length === 0 ? (
        <div className="om-wrap ls-none" id="am-list">
          <p className="ls-none__t">{list.query.trim() ? `Nobody matches “${list.query.trim()}”` : "Nobody matches these filters"}</p>
          <p className="ls-none__p">Search looks at names and email addresses. The role filter uses each person’s effective role.</p>
          {filtered ? (
            <Link className="ah-btn ah-btn--secondary ah-btn--sm" href={pathname} scroll={false} onClick={() => list.setQuery("")}>
              Clear search and filters
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="om-wrap">
          <table className="om-table am-table" id="am-list">
            <caption className="sr-only">People with access to {projectName}</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Source</th>
                <th scope="col">Last active</th>
                <th scope="col">Added by</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.user_id}>
                  <th scope="row" className="om-who">
                    <span className="cp-av" aria-hidden="true">
                      {m.avatar_initials || (m.email[0] ?? "?").toUpperCase()}
                    </span>
                    <span className="om-who__t">
                      <span className="om-name">{m.name || m.email}</span>
                      {m.name && m.name !== m.email ? <span className="om-email">{m.email}</span> : null}
                    </span>
                  </th>
                  <td data-label="Role">
                    <span className={`am-role am-role--${m.effective_role}`}>{ROLE_LABELS[m.effective_role]}</span>
                  </td>
                  <td data-label="Source" className="am-src">
                    <ul className="am-src__list">
                      {sourceLines(m).map((l) => (
                        <li key={l.kind}>
                          {l.text}
                          {l.role ? <span className="am-src__role"> · {l.role}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td data-label="Last active">
                    {m.last_active_at ? <time dateTime={m.last_active_at}>{lastActive(m.last_active_at, now)}</time> : lastActive(null, now)}
                  </td>
                  <td data-label="Added by" className="am-by">
                    {addedBy(m) === "—" ? (
                      "—"
                    ) : (
                      <span className="am-by__t">
                        {addedBy(m)}
                        <time className="am-by__d" dateTime={m.added_at}>
                          {formatJoined(m.added_at)}
                        </time>
                      </span>
                    )}
                  </td>
                  <td className="om-act">
                    <MemberRowMenu project={project} projectName={projectName} member={m} announce={announce} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination pathname={pathname} params={list.params} total={window.total} label="Members pages" className="ls-pages" />
        </div>
      )}
    </>
  );
}
