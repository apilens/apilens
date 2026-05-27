# APILens — GCP Infrastructure

Terraform that stands up the production cloud footprint for APILens on GCP.

## What this provisions

| Resource | Name pattern | Purpose |
|----------|--------------|---------|
| Artifact Registry | `apilens` (Docker repo) | Container images for backend + frontend |
| Cloud SQL Postgres 16 | `apilens-<env>-pg` | Primary database |
| Cloud Run service | `apilens-<env>-backend` | Django + Gunicorn |
| Cloud Run service | `apilens-<env>-frontend` | Next.js standalone |
| Secret Manager | 4 secrets | `django-secret-key`, `session-secret`, `apilens-database-url`, `apilens-clickhouse-url` |
| Service accounts | 3 | Backend runtime, frontend runtime, GitHub-deploy |
| Workload Identity Federation | pool `github-actions` | Keyless GitHub Actions → GCP auth |

The deploy workflows in `.github/workflows/` push images and roll Cloud Run revisions; Terraform owns the wiring.

## What this does NOT provision

- **Custom domains / managed certs** — follow-up. Use Cloud Run domain mapping.
- **ClickHouse** — provisioned outside GCP via ClickHouse Cloud. Terraform creates an empty `apilens-clickhouse-url` Secret Manager entry; you fill in the value after creating the CH project.
- **Email provider (SES/Mailgun/Postmark)** — also follow-up. Default Django console backend ships logs to stdout until you wire SMTP credentials through Secret Manager.

## First-time bootstrap

You need:
- `gcloud` CLI, authenticated against an account with `roles/owner` on the project.
- `terraform` ≥ 1.5.
- A target GCP project (create one with `gcloud projects create` if needed) and its **project number** (`gcloud projects describe <id> --format='value(projectNumber)'`).

### 1. Create the state bucket

Terraform stores its state in GCS so apply is safe from anywhere:

```bash
PROJECT=apilens-prod
gcloud auth application-default login
gcloud config set project "$PROJECT"
gsutil mb -p "$PROJECT" -l us-central1 "gs://$PROJECT-tfstate"
gsutil versioning set on "gs://$PROJECT-tfstate"
```

### 2. Configure variables

```bash
cd infrastructure/gcp/terraform
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars   # fill in project_id, project_number, github_repo
```

### 3. Init + apply

```bash
terraform init -backend-config="bucket=$PROJECT-tfstate"
terraform plan
terraform apply
```

First apply takes ~5 minutes — Cloud SQL is the slow step.

### 4. Populate the secrets that Terraform doesn't own

After apply, three Secret Manager entries still have no payload (`apilens-database-url` is the exception — Terraform writes its first version):

```bash
# Django app secret (used to sign JWTs, CSRF tokens, etc.)
openssl rand -base64 64 | tr -d '\n' | \
  gcloud secrets versions add django-secret-key --data-file=-

# Frontend session cookie key (AES-256-GCM, raw bytes / hex)
openssl rand -hex 32 | tr -d '\n' | \
  gcloud secrets versions add session-secret --data-file=-

# ClickHouse Cloud DSN — after creating the CH project, copy its URL here.
# Until you do this, backend starts fine but ClickHouse queries no-op.
echo -n 'https://default:PWD@xxxx.region.clickhouse.cloud:8443/apilens' | \
  gcloud secrets versions add apilens-clickhouse-url --data-file=-
```

### 5. Confirm Cloud Run is up

```bash
terraform output backend_service_url
terraform output frontend_service_url
```

Both services come up serving the placeholder `gcr.io/cloudrun/hello` image — that's expected. Real images land once PR 3's deploy workflows fire.

### 6. Set GitHub repo secrets for the deploy workflows

Terraform emits everything you need via the `github_secrets_to_set` output:

```bash
terraform output -json github_secrets_to_set | \
  jq -r 'to_entries[] | "\(.key)=\(.value)"' | \
  while IFS='=' read -r k v; do
    gh secret set "$k" --body "$v"
  done
```

Verify in the GitHub UI under **Settings → Secrets and variables → Actions**.

## Adding a new environment

`var.environment` is the only thing baked into resource names. To spin up staging:

```bash
# Separate state file under the same bucket
terraform workspace new staging
terraform apply -var environment=staging -var db_tier=db-f1-micro
```

## Routine operations

- **Rotate the Django secret key:** `openssl rand -base64 64 | gcloud secrets versions add django-secret-key --data-file=-`. Cloud Run instances pick up the new version on next start.
- **Roll Postgres password:** edit `random_password.db_password` to use `keepers`, `terraform apply`, the new password lands in the URL secret.
- **Destroy everything (dev only!):** set `db_deletion_protection = false` in `terraform.tfvars`, `terraform apply`, then `terraform destroy`.

## File map

```
infrastructure/gcp/terraform/
├── providers.tf              Provider pins, remote state config
├── variables.tf              Inputs
├── locals.tf                 Naming + image-path conventions
├── apis.tf                   Enable required Google APIs
├── artifact_registry.tf      Docker repo + cleanup policies
├── cloud_sql.tf              Postgres instance, db, user, password
├── secrets.tf                Secret Manager entries
├── service_accounts.tf       Runtime + deploy SAs
├── workload_identity.tf      WIF pool + provider, GitHub trust
├── iam.tf                    IAM bindings (secret access, actAs, run.admin)
├── cloud_run_backend.tf      Django service definition
├── cloud_run_frontend.tf     Next.js service definition
├── outputs.tf                URLs, image paths, github-secrets dump
└── terraform.tfvars.example  Starter values
```
