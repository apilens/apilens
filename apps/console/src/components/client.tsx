"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import * as React from "react";

import { cn } from "@/lib/cn";
import { THEME_KEY } from "@/lib/theme";
import { CheckIcon, ChevronDownIcon, CopyIcon, ErrorsIcon, MoonIcon, RequestsIcon, SetupIcon, SunIcon, TrafficIcon } from "./icons";

// The few pieces that need the browser. Everything else renders on the server.

export const NAV = [
  { href: "/traffic", label: "Traffic", icon: TrafficIcon },
  { href: "/requests", label: "Requests", icon: RequestsIcon },
  { href: "/errors", label: "Errors", icon: ErrorsIcon },
  { href: "/setup", label: "Setup", icon: SetupIcon },
] as const;

function activeSection(pathname: string): string | undefined {
  if (pathname.startsWith("/traces/")) return "/requests";
  return NAV.find((n) => pathname === n.href || pathname.startsWith(`${n.href}/`))?.href;
}

/** Sidebar navigation; filters (range, env) carry over between sections. */
export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const active = activeSection(pathname);
  const carry = new URLSearchParams();
  for (const key of ["range", "env"]) {
    const v = params.get(key);
    if (v) carry.set(key, v);
  }
  const suffix = carry.toString() ? `?${carry.toString()}` : "";

  return (
    <ul className="flex flex-col gap-px">
      {NAV.map((item) => {
        const isActive = active === item.href;
        const Icon = item.icon;
        return (
          <li key={item.href}>
            <Link
              href={item.href === "/setup" ? item.href : item.href + suffix}
              onClick={onNavigate}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "focus-ring group flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors duration-100",
                isActive ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground hover:bg-sidebar-hover hover:text-foreground",
              )}
            >
              <Icon className={cn("size-4 shrink-0", isActive ? "text-brand" : "text-subtle-foreground group-hover:text-muted-foreground")} />
              <span className="truncate">{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** "Shop / Traffic" in the top bar. */
export function Breadcrumb({ project }: { project: string }) {
  const pathname = usePathname();
  const section = NAV.find((n) => n.href === activeSection(pathname));
  const isTrace = pathname.startsWith("/traces/");
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
      <span className="truncate text-muted-foreground">{project}</span>
      {section ? (
        <>
          <span aria-hidden className="text-subtle-foreground">
            /
          </span>
          <span className={cn("truncate", isTrace ? "text-muted-foreground" : "text-foreground")}>{section.label}</span>
        </>
      ) : null}
      {isTrace ? (
        <>
          <span aria-hidden className="text-subtle-foreground">
            /
          </span>
          <span className="truncate text-foreground">Trace</span>
        </>
      ) : null}
    </nav>
  );
}

/** Mobile navigation: the sidebar collapses into a disclosure below 768px. */
export function MobileNav({ project }: { project: string }) {
  const ref = React.useRef<HTMLDetailsElement>(null);
  return (
    <details ref={ref} className="relative md:hidden">
      <summary className="focus-ring flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm text-foreground shadow-control">
        <span className="max-w-40 truncate">{project}</span>
        <ChevronDownIcon className="size-4 text-subtle-foreground" />
      </summary>
      <div className="absolute top-10 left-0 z-50 w-56 rounded-lg bg-popover p-1 shadow-overlay">
        <NavLinks onNavigate={() => ref.current?.removeAttribute("open")} />
      </div>
    </details>
  );
}



/** Dark is the default; the choice is remembered per browser. */
export function ThemeToggle() {
  // The pre-paint script in the root layout sets data-theme; this reads it
  // without a hydration mismatch (server snapshot is null → icon renders on client).
  const theme = React.useSyncExternalStore(subscribeTheme, readTheme, () => null);
  const next = theme === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          // Storage may be blocked; the toggle still works for this page.
        }
      }}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="focus-ring inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:bg-muted hover:text-foreground"
    >
      {theme === null ? null : theme === "light" ? <MoonIcon className="size-4" /> : <SunIcon className="size-4" />}
    </button>
  );
}

function readTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** Copies a value and confirms in place; announces the result to screen readers. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
      className="focus-ring inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors duration-100 hover:bg-muted hover:text-foreground"
    >
      {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}

/** Environment filter: a GET form, so it also works before hydration. */
export function EnvSelect({ envs, value, keep }: { envs: string[]; value?: string; keep: Record<string, string | undefined> }) {
  const pathname = usePathname();
  return (
    <form method="get" action={pathname} className="relative">
      {Object.entries(keep).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <label className="sr-only" htmlFor="env-filter">
        Environment
      </label>
      <select
        id="env-filter"
        name="env"
        defaultValue={value ?? ""}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="focus-ring h-8 cursor-pointer rounded-md bg-card pr-8 pl-2.5 text-sm text-foreground shadow-control"
      >
        <option value="">All environments</option>
        {envs.map((env) => (
          <option key={env} value={env}>
            {env}
          </option>
        ))}
        {value && !envs.includes(value) ? <option value={value}>{value}</option> : null}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-2 right-2 size-4 text-subtle-foreground" />
      <noscript>
        <button type="submit" className="ml-2 h-8 rounded-md bg-card px-3 text-sm shadow-control">
          Apply
        </button>
      </noscript>
    </form>
  );
}
