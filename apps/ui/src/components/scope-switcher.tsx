"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { ORGS, PROJECTS, SERVICES, type Health } from "@/lib/data";

type Level = 0 | 1 | 2;
interface Row {
  key: string;
  label: string;
  health: Health;
  fact: string;
}

function Hit({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <span>
      {text.slice(0, i)}
      <b className="hit">{text.slice(i, i + q.length)}</b>
      {text.slice(i + q.length)}
    </span>
  );
}

/** Miller columns: Organizations, Projects, Services. Typing filters all three at once. */
export function ScopeSwitcher({ open, onClose, orgSlug, projectSlug }: { open: boolean; onClose: () => void; orgSlug: string; projectSlug: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [org, setOrg] = useState(orgSlug);
  const [project, setProject] = useState(projectSlug);
  const [cur, setCur] = useState<{ level: Level; i: number }>({ level: 1, i: 0 });

  useEffect(() => {
    if (!open) return;
    setQ("");
    setOrg(orgSlug);
    setProject(projectSlug);
    const pi = Math.max(0, PROJECTS.filter((p) => p.org === orgSlug).findIndex((p) => p.slug === projectSlug));
    setCur({ level: 1, i: pi });
    requestAnimationFrame(() => input.current?.focus());
  }, [open, orgSlug, projectSlug]);

  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());

  const cols = useMemo<[Row[], Row[], Row[]]>(() => {
    const orgs = ORGS.filter((o) => match(o.name)).map((o) => ({ key: o.slug, label: o.name, health: o.health, fact: o.fact }));
    const projects = PROJECTS.filter((p) => p.org === org && match(p.name)).map((p) => ({ key: p.slug, label: p.name, health: p.health, fact: String(p.services) }));
    const services = SERVICES.filter((s) => s.project === project && match(s.slug)).map((s) => ({ key: s.slug, label: s.slug, health: s.health, fact: s.fact }));
    return [orgs, projects, services];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, org, project]);

  const orgName = ORGS.find((o) => o.slug === org)?.name ?? "";

  const choose = (level: Level, i: number) => {
    const row = cols[level][i];
    if (!row) return;
    if (level === 0) {
      const first = PROJECTS.find((p) => p.org === row.key);
      setOrg(row.key);
      if (first) setProject(first.slug);
      setCur({ level: 1, i: 0 });
    } else if (level === 1) {
      onClose();
      router.push(`/${row.key}/incidents`);
    } else {
      onClose();
      router.push(`/${project}/apis`);
    }
  };

  // Moving the cursor in a column also selects it, so the next column follows.
  const focusRow = (level: Level, i: number) => {
    const row = cols[level][i];
    if (!row) return;
    if (level === 0) {
      setOrg(row.key);
      const first = PROJECTS.find((p) => p.org === row.key);
      if (first) setProject(first.slug);
    }
    if (level === 1) setProject(row.key);
    setCur({ level, i });
  };

  const onKey = (e: React.KeyboardEvent) => {
    const { level, i } = cur;
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(level, Math.min(cols[level].length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(level, Math.max(0, i - 1));
    } else if (e.key === "ArrowRight" && level < 2 && cols[level + 1].length && !q) {
      e.preventDefault();
      focusRow((level + 1) as Level, 0);
    } else if (e.key === "ArrowLeft" && level > 0 && !q) {
      e.preventDefault();
      const l = (level - 1) as Level;
      const idx = Math.max(0, cols[l].findIndex((r) => r.key === (l === 0 ? org : project)));
      setCur({ level: l, i: idx });
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(level, i);
    }
  };

  if (!open) return null;

  const Col = ({ level, title, empty }: { level: Level; title: string; empty: string }) => (
    <div className="ah-switch__col" role="listbox" aria-label={title}>
      <div className="ah-switch__h">{title}</div>
      {cols[level].length === 0 ? <div className="ah-switch__empty">{empty}</div> : null}
      {cols[level].map((r, i) => {
        const isCursor = cur.level === level && cur.i === i;
        const isOn = !isCursor && (level === 0 ? r.key === org : level === 1 ? r.key === project : false);
        return (
          <div key={r.key} role="option" aria-selected={isCursor} className={`ah-switch__item${isCursor ? " is-cursor" : isOn ? " is-on" : ""}`} onMouseMove={() => !isCursor && setCur({ level, i })} onMouseDown={(e) => e.preventDefault()} onClick={() => { choose(level, i); input.current?.focus(); }}>
            <span className={`ah-sev ah-sev--${r.health}`} />
            <Hit text={r.label} q={q.trim()} />
            <small>{r.fact}</small>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ah ah-switch" role="dialog" aria-modal="true" aria-label="Switch scope" onKeyDown={onKey}>
        <div className="ah-switch__search">
          <Icon name="search" />
          <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setCur((c) => ({ ...c, i: 0 })); }} placeholder="Search organizations, projects and services" aria-label="Search scope" />
          <span className="ah-kbd">Esc</span>
        </div>
        <div className="ah-switch__cols">
          <Col level={0} title="Organizations" empty="No organization matches." />
          <Col level={1} title={`${orgName} · projects`} empty="No project matches." />
          <Col level={2} title={`${project} · services`} empty="No services in this project yet." />
        </div>
        <div className="ah-switch__foot">
          <span><span className="ah-kbd">↑</span><span className="ah-kbd">↓</span> move</span>
          <span><span className="ah-kbd">←</span><span className="ah-kbd">→</span> up / down a level</span>
          <span><span className="ah-kbd">↵</span> open</span>
        </div>
      </div>
    </div>
  );
}
