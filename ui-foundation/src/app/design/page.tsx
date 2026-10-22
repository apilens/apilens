import Link from "next/link";

import { Banner } from "@/components/patterns/banner";
import { EnvBadge } from "@/components/patterns/env-badge";
import { SidebarPreview } from "@/components/patterns/sidebar-preview";
import { Gated } from "@/components/patterns/gated";
import { LiveIndicator } from "@/components/patterns/live-indicator";
import { StatRow, StatTile } from "@/components/patterns/stat-tile";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/patterns/states";
import { TenantAvatar } from "@/components/patterns/tenant-avatar";
import { ThemeToggle } from "@/components/patterns/theme-toggle";
import { TimeRangePicker } from "@/components/patterns/time-range-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field } from "@/components/ui/field";
import { CopyIcon, DotsThreeIcon, FunnelIcon, PlugsConnectedIcon, PlusIcon, ShieldCheckIcon, TrashIcon, WarningIcon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { StatusDot } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { Empty, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { actionsFor } from "@/lib/capabilities";
import { CapabilitiesProvider } from "@/lib/permissions";

export const metadata = { title: "Design reference · Aperture" };

// The living reference. Claude screenshots this page (dark + light, 1440 + 390)
// and compares new screens against it. Every primitive and pattern appears
// here in every state. Add a component → add it here.

const SURFACES = [
  { name: "background", cls: "bg-background", use: "Page canvas" },
  { name: "card", cls: "bg-card", use: "Panels, tables" },
  { name: "popover", cls: "bg-popover", use: "Menus, dialogs" },
  { name: "muted", cls: "bg-muted", use: "Hover rows, wells" },
  { name: "accent", cls: "bg-accent", use: "Selected, pressed" },
  { name: "field", cls: "bg-field", use: "Inputs" },
];
const INKS = [
  { name: "foreground", cls: "text-foreground", use: "Primary text" },
  { name: "muted-foreground", cls: "text-muted-foreground", use: "Secondary text" },
  { name: "subtle-foreground", cls: "text-subtle-foreground", use: "Tertiary, metadata" },
  { name: "brand-text", cls: "text-brand-text", use: "Links, live" },
];
const SIGNALS = [
  { name: "brand", cls: "bg-brand", use: "Focus, selection" },
  { name: "success", cls: "bg-success", use: "2xx, healthy" },
  { name: "warning", cls: "bg-warning", use: "4xx, degraded" },
  { name: "danger", cls: "bg-danger", use: "5xx, failing" },
  { name: "info", cls: "bg-info", use: "Neutral notices" },
  { name: "destructive", cls: "bg-destructive", use: "Destructive fill" },
];
const CHART = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5", "bg-chart-6", "bg-chart-7", "bg-chart-8"];
const TYPE = [
  { cls: "text-3xl font-semibold", spec: "3xl · 32/40 · 600", sample: "1.44M", use: "One hero figure per view" },
  { cls: "text-2xl font-semibold", spec: "2xl · 24/32 · 600", sample: "182 ms", use: "Stat tile values" },
  { cls: "text-xl font-semibold", spec: "xl · 20/28 · 600", sample: "Endpoints", use: "Page title" },
  { cls: "text-lg font-medium", spec: "lg · 16/24 · 500", sample: "Delete project", use: "Dialog title, section" },
  { cls: "text-base", spec: "base · 14/22 · 400", sample: "Requests are sampled at 100% for this plan.", use: "Prose, descriptions" },
  { cls: "text-sm", spec: "sm · 13/20 · 400", sample: "POST /v1/payments/charge returned 502", use: "UI default, table cells" },
  { cls: "text-xs text-muted-foreground", spec: "xs · 12/16 · 400", sample: "Last event 12s ago", use: "Hints, metadata" },
  { cls: "text-2xs text-subtle-foreground", spec: "2xs · 11/16 · 400", sample: "Request req_8f2c91", use: "Floor. Badges, ids" },
  { cls: "font-mono text-xs", spec: "mono xs · 12/16", sample: "apl_live_3f9a••••••••", use: "Paths, ids, keys, code" },
];

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-border py-10">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Swatch({ cls, name, use }: { cls: string; name: string; use: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`size-9 shrink-0 rounded-md shadow-control ${cls}`} />
      <span className="min-w-0">
        <span className="block truncate font-mono text-xs text-foreground">{name}</span>
        <span className="block truncate text-xs text-subtle-foreground">{use}</span>
      </span>
    </div>
  );
}

const NAV = [
  ["color", "Color"],
  ["type", "Type"],
  ["depth", "Depth"],
  ["controls", "Controls"],
  ["status", "Status"],
  ["data", "Data"],
  ["states", "States"],
  ["navigation", "Navigation"],
  ["tenancy", "Tenancy"],
] as const;

export default function DesignPage() {
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-6 px-6">
          <Link href="/" className="focus-ring rounded-sm text-sm font-semibold text-foreground">
            Aperture
          </Link>
          <nav aria-label="Sections" className="hidden items-center gap-4 md:flex">
            {NAV.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="focus-ring rounded-sm text-sm text-muted-foreground transition-colors duration-100 hover:text-foreground">
                {label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/projects/checkout-api">Open demo app</Link>
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24">
        <div className="py-10">
          <h1 className="text-2xl font-semibold text-foreground">Design reference</h1>
          <p className="mt-2 max-w-2xl text-base text-muted-foreground">
            Every token, primitive and pattern in APILens, in every state. New screens are composed from what is on this page. If
            something you need is missing, add it here first.
          </p>
        </div>

        <Section id="color" title="Color" description="Surfaces step up in lightness with elevation. Three text inks only. Signal colors carry meaning and nothing else.">
          <div className="grid gap-8 lg:grid-cols-3">
            <div className="grid content-start gap-3">
              <h3 className="text-xs font-medium text-subtle-foreground">Surfaces</h3>
              {SURFACES.map((s) => (
                <Swatch key={s.name} {...s} />
              ))}
            </div>
            <div className="grid content-start gap-3">
              <h3 className="text-xs font-medium text-subtle-foreground">Ink</h3>
              {INKS.map((s) => (
                <div key={s.name} className="flex items-center gap-3">
                  <span className={`flex size-9 shrink-0 items-center justify-center rounded-md bg-card text-base font-semibold shadow-control ${s.cls}`}>Aa</span>
                  <span>
                    <span className="block font-mono text-xs text-foreground">{s.name}</span>
                    <span className="block text-xs text-subtle-foreground">{s.use}</span>
                  </span>
                </div>
              ))}
            </div>
            <div className="grid content-start gap-3">
              <h3 className="text-xs font-medium text-subtle-foreground">Signals</h3>
              {SIGNALS.map((s) => (
                <Swatch key={s.name} {...s} />
              ))}
            </div>
          </div>
          <div className="mt-8">
            <h3 className="mb-3 text-xs font-medium text-subtle-foreground">Chart series (fixed order, never cycled)</h3>
            <div className="flex gap-2">
              {CHART.map((c, i) => (
                <span key={c} className="flex flex-col items-center gap-1.5">
                  <span className={`h-8 w-12 rounded-sm ${c}`} />
                  <span className="font-mono text-2xs text-subtle-foreground">{i + 1}</span>
                </span>
              ))}
            </div>
          </div>
        </Section>

        <Section id="type" title="Type" description="IBM Plex Sans for UI, IBM Plex Mono for paths, ids and code. Ratio ~1.2, three weights, nothing under 11px.">
          <Panel>
            <ul className="divide-y divide-border">
              {TYPE.map((t) => (
                <li key={t.spec} className="grid items-baseline gap-2 px-4 py-3 md:grid-cols-12">
                  <span className="font-mono text-2xs text-subtle-foreground md:col-span-3">{t.spec}</span>
                  <span className={`truncate text-foreground md:col-span-6 ${t.cls}`}>{t.sample}</span>
                  <span className="text-xs text-muted-foreground md:col-span-3">{t.use}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </Section>

        <Section id="depth" title="Depth" description="Controls read as made: inset hairline, top highlight, bottom edge. On dark, highlights do the work shadows can't.">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["shadow-panel", "Panels, inputs", "bg-card"],
              ["shadow-control", "Secondary controls", "bg-card"],
              ["shadow-control-primary", "Primary control", "bg-primary"],
              ["shadow-overlay", "Menus, dialogs", "bg-popover"],
            ].map(([shadow, use, bg]) => (
              <div key={shadow} className="grid gap-2">
                <div className={`h-20 rounded-lg ${bg} ${shadow} ${shadow === "shadow-panel" ? "border border-border" : ""}`} />
                <span className="font-mono text-xs text-foreground">{shadow}</span>
                <span className="text-xs text-subtle-foreground">{use}</span>
              </div>
            ))}
          </div>
          <div className="mt-8 flex flex-wrap items-end gap-6">
            {[
              ["rounded-sm", "4px · badges, kbd"],
              ["rounded-md", "6px · controls"],
              ["rounded-lg", "8px · panels, menus"],
              ["rounded-xl", "10px · dialogs"],
            ].map(([r, use]) => (
              <div key={r} className="grid gap-2">
                <div className={`size-16 border border-input bg-card ${r}`} />
                <span className="font-mono text-xs text-foreground">{r}</span>
                <span className="text-xs text-subtle-foreground">{use}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section id="controls" title="Controls" description="Dense by default: 28 / 32 / 36px. Primary is inverted neutral; brand color is reserved for focus and selection.">
          <div className="grid gap-8">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary">Create API key</Button>
              <Button>Export CSV</Button>
              <Button variant="ghost">Cancel</Button>
              <Button variant="destructive">Revoke key</Button>
              <Button variant="link">View docs</Button>
              <Button variant="primary" loading>
                Saving
              </Button>
              <Button disabled>Disabled</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm">
                <FunnelIcon />
                Filter
              </Button>
              <Button size="md">
                <PlusIcon />
                Add rule
              </Button>
              <Button size="lg" variant="primary">
                Send test request
              </Button>
              <Tooltip content="Copy request id">
                <Button size="icon" aria-label="Copy request id">
                  <CopyIcon />
                </Button>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" aria-label="Endpoint actions">
                    <DotsThreeIcon weight="bold" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>POST /v1/payments/charge</DropdownMenuLabel>
                  <DropdownMenuItem>
                    <CopyIcon />
                    Copy path
                    <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <PlugsConnectedIcon />
                    Open in trace explorer
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive>
                    <TrashIcon />
                    Stop tracking endpoint
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <TimeRangePicker />
            </div>
            <div className="grid max-w-3xl gap-4 sm:grid-cols-3">
              <Field label="Endpoint path" hint="Supports {param} templates.">
                <Input placeholder="/v1/orders/{id}" mono />
              </Field>
              <Field label="Threshold" error="Enter a value between 1 and 60,000 ms.">
                <Input defaultValue="0" inputMode="numeric" />
              </Field>
              <Field label="Region">
                <Input defaultValue="eu-west-1" disabled />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-6">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Switch defaultChecked /> Capture request bodies
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Switch /> Sample 10% of traffic
              </label>
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                Search <Kbd>⌘</Kbd>
                <Kbd>K</Kbd>
              </span>
            </div>
            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="requests">Requests</TabsTrigger>
                <TabsTrigger value="trace">Trace</TabsTrigger>
              </TabsList>
              <TabsContent value="overview">
                <p className="text-sm text-muted-foreground">Tabs switch views of the same object. Selection is a 2px brand underline.</p>
              </TabsContent>
              <TabsContent value="requests">
                <p className="text-sm text-muted-foreground">Requests view.</p>
              </TabsContent>
              <TabsContent value="trace">
                <p className="text-sm text-muted-foreground">Trace view.</p>
              </TabsContent>
            </Tabs>
            <div>
              <Dialog>
                <DialogTrigger asChild>
                  <Button>Open dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Rotate ingest key</DialogTitle>
                    <DialogDescription>The current key keeps working for 24 hours so you can roll out the new one.</DialogDescription>
                  </DialogHeader>
                  <DialogBody>
                    <Field label="Key name">
                      <Input defaultValue="Production ingest" />
                    </Field>
                  </DialogBody>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button variant="ghost">Cancel</Button>
                    </DialogClose>
                    <Button variant="primary">Rotate key</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </Section>

        <Section id="status" title="Status" description="Status is never color alone: a dot or icon always ships with its word.">
          <div className="flex flex-wrap items-center gap-3">
            <Badge>Draft</Badge>
            <Badge tone="brand">Beta</Badge>
            <Badge tone="success" dot>
              Healthy
            </Badge>
            <Badge tone="warning" dot>
              Degraded
            </Badge>
            <Badge tone="danger" dot>
              Failing
            </Badge>
            <Badge tone="info">SDK 0.4.0</Badge>
            <Badge mono>GET</Badge>
            <EnvBadge env="production" />
            <EnvBadge env="staging" />
            <EnvBadge env="development" />
            <LiveIndicator />
            <LiveIndicator paused />
          </div>
          <div className="mt-5 flex flex-wrap gap-6">
            <StatusDot status="success" label="200 OK" />
            <StatusDot status="warning" label="429 Too Many Requests" />
            <StatusDot status="danger" label="502 Bad Gateway" />
            <StatusDot status="neutral" label="No data" />
          </div>
        </Section>

        <Section id="data" title="Data" description="One panel per table or KPI row. Numbers right-aligned in tabular figures; identifiers in mono; empty cells are an em dash.">
          <StatRow className="mb-6">
            <StatTile label="Requests" value="1.4M" delta={0.124} trend={[61, 64, 62, 68, 73, 70, 76, 80, 77, 84, 86, 90]} />
            <StatTile label="Server errors (5xx)" value="0.11%" delta={0.42} upIsGood={false} trend={[2, 2, 3, 2, 3, 4, 3, 5, 6, 5, 7, 8]} />
            <StatTile label="p95 latency" value="182 ms" delta={-0.058} upIsGood={false} />
            <StatTile label="Active consumers" value="38" delta={0} />
          </StatRow>
          <Panel>
            <PanelHeader title="Slowest endpoints" description="p95 over the last hour" />
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Consumer</TableHead>
                  <TableHead numeric>Requests</TableHead>
                  <TableHead numeric>p95</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell mono>POST /v1/payments/charge</TableCell>
                  <TableCell>mobile-ios</TableCell>
                  <TableCell numeric>64,118</TableCell>
                  <TableCell numeric tone="warning">
                    1.24 s
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell mono>POST /v1/checkout/sessions</TableCell>
                  <TableCell>
                    <Empty />
                  </TableCell>
                  <TableCell numeric>182,430</TableCell>
                  <TableCell numeric>241 ms</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell mono>GET /v1/orders</TableCell>
                  <TableCell>web-checkout</TableCell>
                  <TableCell numeric>211,902</TableCell>
                  <TableCell numeric>96 ms</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Panel>
        </Section>

        <Section id="states" title="States" description="Every data surface ships empty, loading, error and populated. The empty state names the one action that fills it.">
          <div className="grid gap-6 lg:grid-cols-3">
            <Panel>
              <PanelHeader title="Empty" />
              <EmptyState
                icon={<PlugsConnectedIcon />}
                title="No requests yet"
                description="Install the SDK and send one request. It appears here within a few seconds."
                action={<Button variant="primary">View setup guide</Button>}
              />
            </Panel>
            <Panel>
              <PanelHeader title="Loading" />
              <TableSkeleton rows={6} columns={4} />
            </Panel>
            <Panel>
              <PanelHeader title="Error" />
              <ErrorState
                title="Couldn't load endpoints"
                description="The analytics service timed out after 10 s. Your data is safe; retry in a moment."
                requestId="req_8f2c91d0"
                action={<Button size="sm">Retry</Button>}
              />
            </Panel>
          </div>
        </Section>

        <Section
          id="navigation"
          title="Navigation"
          description="Scope first (organization and project), then the job: monitor, explore, configure. Counts only for things that need action. Collapses to a rail with [."
        >
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <SidebarPreview scope={{ kind: "project", slug: "checkout-api", orgSlug: "northwind" }} active="/errors" />
              <p className="mt-2 text-xs text-subtle-foreground">Project scope, expanded. Open the switcher: hover organizations, type to search all projects.</p>
            </div>
            <div className="lg:col-span-3">
              <SidebarPreview scope={{ kind: "project", slug: "checkout-api", orgSlug: "northwind" }} active="/errors" collapsed />
              <p className="mt-2 text-xs text-subtle-foreground">Collapsed rail. Labels and shortcuts in tooltips.</p>
            </div>
            <div className="lg:col-span-4">
              <SidebarPreview scope={{ kind: "org", slug: "halcyon-health" }} active="/projects" />
              <p className="mt-2 text-xs text-subtle-foreground">Organization scope: billing and members live here. Usage at 91% turns danger.</p>
            </div>
          </div>
        </Section>

        <Section id="tenancy" title="Tenancy" description="Who you are acting as, in which project, with what permission: always visible, never ambiguous.">
          <div className="grid gap-6">
            <div className="flex flex-wrap items-center gap-4">
              {[
                ["Checkout API", "checkout-api"],
                ["Payments Gateway", "payments-gateway"],
                ["Partner Sync", "partner-sync"],
              ].map(([name, slug]) => (
                <span key={slug} className="flex items-center gap-2 text-sm text-foreground">
                  <TenantAvatar name={name} slug={slug} />
                  {name}
                </span>
              ))}
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              <Banner tone="warning" icon={<ShieldCheckIcon />}>
                Support access is on. An APILens engineer can view this project until 18:00 UTC.
              </Banner>
              <Banner tone="danger" icon={<WarningIcon />}>
                Ingestion is delayed in eu-west-1. Data from the last 6 minutes may be missing.
              </Banner>
            </div>
            <CapabilitiesProvider role="viewer" actions={actionsFor("viewer")}>
              <Panel className="max-w-xl">
                <PanelHeader title="Permission-aware controls" description="Signed in as viewer. Hover the disabled button." />
                <PanelBody className="flex flex-wrap gap-2">
                  <Gated action="api_keys.create">
                    <Button variant="primary">Create API key</Button>
                  </Gated>
                  <Gated action="members.invite">
                    <Button>Invite member</Button>
                  </Gated>
                  <Gated action="billing.manage" mode="hide">
                    <Button>Manage billing</Button>
                  </Gated>
                </PanelBody>
              </Panel>
            </CapabilitiesProvider>
          </div>
        </Section>
      </main>
    </div>
  );
}
