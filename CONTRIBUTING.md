# Contributing to APILens

Thanks for helping build APILens! This guide covers local setup, the repo
layout, and how changes get reviewed and merged.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
Report security issues privately — see [SECURITY.md](SECURITY.md), never in a
public issue.

## Development setup

Prerequisites: Git, Docker (with Compose v2), and either
[mise](https://mise.jdx.dev) or the toolchains it pins in `mise.toml`
(Go, Node + pnpm, Python + uv). Install [Task](https://taskfile.dev) to run
the project commands.

```sh
git clone https://github.com/apilens/apilens.git
cd apilens
task bootstrap   # install tools, start dev datastores, migrate, seed a dev project
task dev         # run the Go binary, web dashboard and AI service together
```

Useful tasks (run `task --list` for everything):

| Command | What it does |
|---|---|
| `task up` / `task down` | Start / stop the dev datastores (Postgres, ClickHouse, Valkey) |
| `task migrate` | Apply Postgres and ClickHouse migrations |
| `task seed` | Create a dev org, project, app and API key |
| `task gen` | Regenerate protobuf, sqlc and OpenAPI output |
| `task lint` | Run all linters |
| `task test` | Unit tests |
| `task test:integration` | Integration tests against real databases (testcontainers; needs Docker) |
| `task test:e2e` | End-to-end tests against the compose all-in-one stack |

## Repository layout

| Path | Contents |
|---|---|
| `cmd/apilens` | The single Go binary; `-target=` selects its roles (edge, query, api, …) |
| `internal/` | All Go server code: `platform/` infrastructure plus one package per domain module |
| `proto/` | Protobuf contracts (source of truth for event schemas) |
| `api/openapi/` | Committed OpenAPI spec generated from the Go API |
| `apps/web` | Next.js dashboard |
| `apps/ai` | Python AI/ML service |
| `apps/docs` | Documentation site |
| `packages/sdk-*` | Published SDKs (Python, TypeScript, Java), versioned independently |
| `deploy/` | Dockerfiles, docker compose (self-host and dev) and the Helm chart |
| `docs/adr/` | Architecture decision records |

Generated code (protobuf, sqlc, OpenAPI) is committed. After changing a
`.proto` file, a SQL query or an API operation, run `task gen` and commit the
result — CI fails if generated code is stale.

## Making a change

1. For anything beyond a small fix, open an issue (or comment on an existing
   one) first so we can agree on the approach. Architectural changes need an
   ADR in `docs/adr/` — see [GOVERNANCE.md](GOVERNANCE.md).
2. Create a branch from `main` (during the v2 rebuild, from `v2`).
3. Keep changes focused, add or update tests, and run `task lint test` (plus
   `task test:integration` if you touched storage or ingest code).
4. Open a pull request using the template.

### Commit and PR titles

We use [Conventional Commits](https://www.conventionalcommits.org/). PRs are
squash-merged, so the **PR title** becomes the commit message and drives the
changelog and version bumps:

```
feat(ingest): accept OTLP logs over HTTP
fix(web): keep the time range when switching projects
perf(query): read the hourly rollup for ranges over 7 days
feat(api)!: rename the projects endpoint   # ! marks a breaking change
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
`chore`, `deps`, `revert`. The scope is optional.

Optional git hooks run the fast checks before each commit:
`lefthook install`.

### Developer Certificate of Origin (DCO)

Every commit must be signed off to certify you wrote it or have the right to
submit it under the project's MIT license
([developercertificate.org](https://developercertificate.org/)):

```sh
git commit -s -m "fix(ingest): reject empty batches"
```

This adds a `Signed-off-by: Your Name <you@example.com>` trailer. To sign off
commits you already made: `git rebase --signoff main`.

### Review and merge

- CI must be green. The single required check is `ci-passed`, which aggregates
  every job that ran for your change.
- At least one maintainer approval is required; code owners are requested
  automatically (see `.github/CODEOWNERS`).
- Maintainers squash-merge once the PR is approved and up to date.

## Reporting bugs and requesting features

Use the issue forms on GitHub. Please include versions, deployment type and
reproduction steps, and strip secrets and personal data from logs.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
