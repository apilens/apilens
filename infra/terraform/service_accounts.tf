# Runtime SA assumed by the backend Cloud Run service. Only gets the minimum
# permissions it needs at request time (secret-accessor + logs). Postgres is
# at Supabase, reached over the public internet — no cloudsql.client needed.
resource "google_service_account" "backend_runtime" {
  account_id   = "${local.name_prefix}-backend-run"
  display_name = "APILens backend Cloud Run runtime"
}

# Runtime SA for the frontend service. Just needs to read its one secret and write logs.
resource "google_service_account" "frontend_runtime" {
  account_id   = "${local.name_prefix}-frontend-run"
  display_name = "APILens frontend Cloud Run runtime"
}

# Deploy SA — impersonated by GitHub Actions via Workload Identity Federation.
# Holds Cloud Run + Artifact Registry write permissions, and the `actAs` role
# on each runtime SA so `gcloud run deploy --service-account=...` works.
resource "google_service_account" "github_deploy" {
  account_id   = "${local.name_prefix}-github-deploy"
  display_name = "GitHub Actions deploy SA for APILens"
}
