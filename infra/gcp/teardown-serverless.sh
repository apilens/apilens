#!/usr/bin/env bash
# ============================================================================
# Retire the OLD serverless stack (Cloud Run + Cloud SQL) to stop billing.
#
# Run this AFTER the new single-VM stack is verified healthy. It is
# DESTRUCTIVE: it deletes the Cloud SQL instance and ALL of its data.
#
# Usage:
#   PROJECT=my-project ./teardown-serverless.sh
# ============================================================================
set -euo pipefail

: "${PROJECT:?Set PROJECT=<gcp-project-id>}"
REGION="${REGION:-asia-south1}"
ENVIRONMENT="${ENVIRONMENT:-prod}"

SQL_INSTANCE="apilens-${ENVIRONMENT}-pg"
BACKEND_SVC="apilens-${ENVIRONMENT}-backend"
FRONTEND_SVC="apilens-${ENVIRONMENT}-frontend"

cat <<WARN

############################################################################
#  !!  DANGER  !!
#
#  This DELETES the Cloud SQL instance "${SQL_INSTANCE}"
#  and ALL of its data, plus the Cloud Run services:
#    - ${BACKEND_SVC}
#    - ${FRONTEND_SVC}
#
#  Project: ${PROJECT}   Region: ${REGION}
############################################################################

If you have NOT exported the database yet, do it FIRST, e.g.:

  gcloud sql export sql ${SQL_INSTANCE} gs://${PROJECT}-media/backups/pg-final.sql.gz \\
      --database=apilens --project ${PROJECT}

WARN

read -r -p "Continue? [yes/NO] " answer
if [[ "${answer}" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

echo ">> Removing deletion protection on ${SQL_INSTANCE}"
gcloud sql instances patch "${SQL_INSTANCE}" --no-deletion-protection --project "${PROJECT}" || true

echo ">> Deleting Cloud Run service ${BACKEND_SVC}"
gcloud run services delete "${BACKEND_SVC}" --region "${REGION}" --project "${PROJECT}" --quiet || true

echo ">> Deleting Cloud Run service ${FRONTEND_SVC}"
gcloud run services delete "${FRONTEND_SVC}" --region "${REGION}" --project "${PROJECT}" --quiet || true

echo ">> Deleting Cloud SQL instance ${SQL_INSTANCE}"
gcloud sql instances delete "${SQL_INSTANCE}" --project "${PROJECT}" --quiet || true

cat <<DONE

Serverless teardown finished.

Now reconcile Terraform state so the removed resources don't linger:

  cd infra/gcp/terraform
  terraform apply

DONE
