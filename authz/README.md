# authz

SpiceDB schema for APILens ([ADR 0006](../docs/adr/0006-authorization-spicedb.md)).

- `schema.zed` defines `user`, `organization` and `project`.
- `schema.validation.yaml` holds the test fixture and the assertions for every cell of the table below.

Run `task lint:authz` to validate both files with `zed validate`. It is also part of `task lint`.

`schema.go` embeds `schema.zed` into the binary. `apilens migrate` writes it to SpiceDB through the API (idempotent) whenever `authz.endpoint` is set; `apilens migrate -only=authz` applies just the schema. SpiceDB runs in `deploy/compose` (dev and self-host) and optionally in the Helm chart (`spicedb.enabled`).

## Roles

| Resource | Relation | Granted by |
| --- | --- | --- |
| `organization` | `owner`, `admin`, `member`, `viewer` | Org membership (one role per user) |
| `project` | `org` | The project's organization |
| `project` | `admin`, `editor`, `viewer` | Optional sharing of a single project |

Org roles flow down to every project in the org. Direct project roles never grant anything on the org or on other projects.

## Role → action mapping

The UI gates on the `Action` vocabulary (`docs/architecture/identity.md`, mirrored in `apps/ui/src/lib/capabilities.ts`, both added by #294). Each action resolves to exactly one SpiceDB permission:

| UI action | SpiceDB permission | Org owner | Org admin | Org member | Org viewer | Project admin | Project editor | Project viewer |
| --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `project.read` | `project#view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `project.update` | `project#edit` | ✓ | ✓ | ✓ | | ✓ | ✓ | |
| `project.delete` | `project#delete` | ✓ | ✓ | | | ✓ | | |
| `api_keys.create` | `project#manage_keys` | ✓ | ✓ | ✓ | | ✓ | ✓ | |
| `api_keys.revoke` | `project#manage_keys` | ✓ | ✓ | ✓ | | ✓ | ✓ | |
| `members.invite` | `organization#invite` | ✓ | ✓ | | | | | |
| `members.remove` | `organization#manage_members` | ✓ | ✓ | | | | | |
| `billing.manage` | `organization#manage_billing` | ✓ | | | | | | |

The org-level permissions are not part of the UI vocabulary. They gate the org screens:

| Permission | Org owner | Org admin | Org member | Org viewer |
| --- | :-: | :-: | :-: | :-: |
| `organization#manage` (org settings) | ✓ | ✓ | | |
| `organization#create_project` | ✓ | ✓ | ✓ | |
| `organization#view` | ✓ | ✓ | ✓ | ✓ |

## Changing the schema

1. Edit `schema.zed`.
2. Update the table above and the assertions in `schema.validation.yaml` in the same change.
3. Run `task lint:authz`.

The schema is append-friendly: SpiceDB rejects a schema write that removes a relation still in use, so rename or remove a relation in two steps (stop writing it, then delete it).
