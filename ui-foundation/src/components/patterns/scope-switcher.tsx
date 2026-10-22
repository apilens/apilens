"use client";

import { usePathname, useRouter } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { CaretUpDownIcon, CheckIcon, PlusIcon } from "@/components/ui/icon";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { ROLE_LABEL } from "@/lib/capabilities";
import { ORGANIZATIONS, PROJECTS, orgBySlug, projectBySlug } from "@/lib/demo-data";
import type { Scope } from "./nav-config";
import { TenantAvatar } from "./tenant-avatar";

/**
 * Org + project scope switcher (top of the sidebar).
 *
 * Left: organizations. Hover or arrow keys preview an org's projects; a click
 * opens that org. Right: the previewed org's projects. Typing searches projects
 * across ALL orgs, so you never have to switch org first. Picking a project
 * keeps the current section (Traffic → Traffic) and drops resource ids.
 *
 * Keys: O then P opens it · ↑↓ move · ↵ open · ←→ change organization · Esc closes.
 */
export function ScopeSwitcher({
  scope,
  collapsed = false,
  open,
  onOpenChange,
  onNavigate,
}: {
  scope: Scope;
  collapsed?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const project = scope.kind === "project" ? projectBySlug(scope.slug) : null;
  const org = orgBySlug(scope.kind === "project" ? scope.orgSlug : scope.slug);

  const [previewOrg, setPreviewOrgState] = React.useState(org.slug);
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState("");

  const itemValue = (p: (typeof PROJECTS)[number]) => `${p.name} ${p.org} ${p.slug}`;
  // Previewing an org highlights its first project (or the current one), so ↵ works immediately.
  const setPreviewOrg = (slug: string) => {
    setPreviewOrgState(slug);
    const inOrg = PROJECTS.filter((p) => p.orgSlug === slug);
    const pick = inOrg.find((p) => p.slug === project?.slug) ?? inOrg[0];
    setSelected(pick ? itemValue(pick) : "");
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setPreviewOrg(org.slug);
      setQuery("");
    }
    onOpenChange(next);
  };

  const section = scope.kind === "project" ? pathname.split("/")[3] : undefined;
  const go = (href: string) => {
    onOpenChange(false);
    onNavigate?.();
    router.push(href);
  };

  const orgIndex = Math.max(0, ORGANIZATIONS.findIndex((o) => o.slug === previewOrg));
  const cycleOrg = (delta: number) => {
    const n = ORGANIZATIONS.length;
    setPreviewOrg(ORGANIZATIONS[(orgIndex + delta + n) % n].slug);
  };

  const previewed = orgBySlug(previewOrg);
  const groups = query
    ? ORGANIZATIONS.map((o) => ({ org: o, projects: PROJECTS.filter((p) => p.orgSlug === o.slug) }))
    : [{ org: previewed, projects: PROJECTS.filter((p) => p.orgSlug === previewed.slug) }];

  const title = project ? project.name : org.name;
  const subtitle = project ? org.name : `${org.plan} plan`;
  const mark = project ? { name: project.name, slug: project.slug } : { name: org.name, slug: org.slug };

  const trigger = collapsed ? (
    <Button variant="ghost" size="icon" aria-label={`Switch project. Current: ${title}, ${subtitle}`}>
      <TenantAvatar name={mark.name} slug={mark.slug} />
    </Button>
  ) : (
    <Button variant="ghost" className="h-10 min-w-0 flex-1 justify-start gap-2.5 px-2 text-left" aria-label={`Switch project. Current: ${title}, ${subtitle}`}>
      <TenantAvatar name={mark.name} slug={mark.slug} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs text-subtle-foreground">{subtitle}</span>
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
      </span>
      <CaretUpDownIcon className="text-subtle-foreground" />
    </Button>
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {collapsed ? (
        <Tooltip side="right" content={<ShortcutLabel label={`${title} · ${subtitle}`} keys={["O", "P"]} />}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      )}

      <PopoverContent size="wide" side={collapsed ? "right" : "bottom"} className="p-0">
        <div className="flex flex-col sm:flex-row">
          {/* Organizations */}
          <div className="flex shrink-0 flex-col border-b border-border bg-muted/40 sm:w-52 sm:border-r sm:border-b-0">
            <p className="px-3 pt-3 pb-1 text-xs font-medium text-subtle-foreground">Organizations</p>
            <ul className="flex gap-1 overflow-x-auto px-1.5 pb-1.5 sm:flex-col sm:gap-px sm:overflow-visible">
              {ORGANIZATIONS.map((o) => {
                const isPreview = o.slug === previewOrg && !query;
                return (
                  <li key={o.slug} className="shrink-0">
                    <Button
                      variant="ghost"
                      data-active={isPreview}
                      className="h-9 w-full justify-start gap-2 px-2 text-left"
                      onMouseEnter={() => setPreviewOrg(o.slug)}
                      onFocus={() => setPreviewOrg(o.slug)}
                      onClick={() => go(`/orgs/${o.slug}/projects`)}
                    >
                      <TenantAvatar name={o.name} slug={o.slug} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">{o.name}</span>
                        <span className="block truncate text-2xs text-subtle-foreground">{o.plan}</span>
                      </span>
                      {o.slug === org.slug ? <CheckIcon weight="bold" className="text-muted-foreground" /> : null}
                    </Button>
                  </li>
                );
              })}
            </ul>
            <div className="mt-auto hidden border-t border-border p-1.5 sm:block">
              <Button variant="ghost" size="sm" className="w-full justify-start">
                <PlusIcon />
                New organization
              </Button>
            </div>
          </div>

          {/* Projects */}
          <Command className="min-w-0 flex-1" loop value={selected} onValueChange={setSelected}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Find a project in any organization…"
              aria-label="Find a project"
              onKeyDown={(e) => {
                if (query) return;
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  cycleOrg(e.key === "ArrowRight" ? 1 : -1);
                }
              }}
            />
            <CommandList className="max-h-72">
              <CommandEmpty>No projects match “{query}”.</CommandEmpty>
              {groups.map(({ org: o, projects }) =>
                projects.length ? (
                  <CommandGroup key={o.slug} heading={query ? o.name : `Projects in ${o.name}`}>
                    {projects.map((p) => (
                      <CommandItem key={p.slug} value={itemValue(p)} onSelect={() => go(`/projects/${p.slug}${section ? `/${section}` : ""}`)}>
                        <TenantAvatar name={p.name} slug={p.slug} size="sm" />
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        <span className="text-2xs text-subtle-foreground">{ROLE_LABEL[p.role]}</span>
                        {p.slug === project?.slug ? <CheckIcon weight="bold" className="text-muted-foreground" /> : <span aria-hidden className="size-4" />}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null,
              )}
            </CommandList>
            <div className="flex items-center gap-3 border-t border-border px-1.5 py-1.5">
              <Button variant="ghost" size="sm">
                <PlusIcon />
                Create project
              </Button>
              <span className="ml-auto hidden items-center gap-1 pr-1.5 text-2xs text-subtle-foreground sm:flex">
                <Kbd>←</Kbd>
                {/* ui-guard-ignore no-template-chrome: arrow-key glyph in a Kbd, not a button arrow */}
                <Kbd>→</Kbd> organizations
              </span>
            </div>
          </Command>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Tooltip body: label followed by its key sequence. */
export function ShortcutLabel({ label, keys }: { label: string; keys: string[] }) {
  return (
    <span className="flex items-center gap-2">
      <span>{label}</span>
      <span className="flex items-center gap-0.5">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
    </span>
  );
}
