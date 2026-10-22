import { DangerZone } from "@/components/patterns/danger-zone";
import { Gated } from "@/components/patterns/gated";
import { PageHeader } from "@/components/patterns/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { KeyIcon, PlusIcon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Panel, PanelBody, PanelFooter, PanelHeader } from "@/components/ui/panel";
import { Empty, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { API_KEYS, DEMO_NOW, projectBySlug } from "@/lib/demo-data";
import { formatRelative, formatTimestamp } from "@/lib/format";

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = projectBySlug(slug);

  return (
    <>
      <PageHeader title="Settings" description={`Configuration for ${project.name}. Changes apply to every environment.`} />

      <Tabs defaultValue="general" className="max-w-3xl">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="api-keys">API keys</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="grid gap-6">
          <Panel>
            <PanelHeader title="Project" description="Name and identifier used across the dashboard and SDKs" />
            <PanelBody className="grid gap-4 sm:grid-cols-2">
              <Field label="Project name" hint="Shown in the project switcher." editableBy="project.update">
                <Input name="name" defaultValue={project.name} autoComplete="off" />
              </Field>
              <Field label="Slug" hint="Used in URLs. Changing it breaks existing links." editableBy="project.update">
                <Input name="slug" defaultValue={project.slug} mono spellCheck={false} autoComplete="off" />
              </Field>
            </PanelBody>
            <PanelFooter>
              <Gated action="project.update">
                <Button variant="primary">Save changes</Button>
              </Gated>
            </PanelFooter>
          </Panel>

          <DangerZone
            resourceName={project.slug}
            actions={[
              {
                title: "Transfer project",
                consequence: "Move this project and its data to another organization. Members lose access unless they belong to both.",
                button: "Transfer project",
                action: "project.delete",
              },
              {
                title: "Delete project",
                consequence: "Permanently delete this project, its API keys and all request data. This can't be undone.",
                button: "Delete project",
                action: "project.delete",
              },
            ]}
          />
        </TabsContent>

        <TabsContent value="api-keys">
          <Panel>
            <PanelHeader
              title="API keys"
              description="Keys authenticate the SDK. The full key is shown once, when it's created."
              actions={
                <Gated action="api_keys.create">
                  <Button variant="primary" size="sm">
                    <PlusIcon />
                    Create API key
                  </Button>
                </Gated>
              }
            />
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead className="w-20">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {API_KEYS.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <KeyIcon className="size-4 text-subtle-foreground" />
                        {k.name}
                      </span>
                    </TableCell>
                    <TableCell mono>
                      <span className="text-foreground">{k.prefix}</span>
                      <span className="text-subtle-foreground">••••••••</span>
                    </TableCell>
                    <TableCell tone="muted">
                      <time dateTime={k.createdAt.toISOString()} title={formatTimestamp(k.createdAt)}>
                        {formatRelative(k.createdAt, DEMO_NOW)}
                      </time>
                    </TableCell>
                    <TableCell tone="muted">
                      {k.lastUsedAt ? (
                        <time dateTime={k.lastUsedAt.toISOString()} title={formatTimestamp(k.lastUsedAt)}>
                          {formatRelative(k.lastUsedAt, DEMO_NOW)}
                        </time>
                      ) : (
                        <span className="flex items-center gap-2">
                          <Empty />
                          <Badge>Never used</Badge>
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Gated action="api_keys.revoke">
                        <Button variant="destructive-ghost" size="sm">
                          Revoke
                        </Button>
                      </Gated>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        </TabsContent>
      </Tabs>
    </>
  );
}
