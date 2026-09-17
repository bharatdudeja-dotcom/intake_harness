#!/usr/bin/env bash
#
# Agent Manager on Cloud Run. Idempotent: safe to re-run, and re-running is how
# you deploy a new revision.
#
#   ./deploy/gcp.sh
#
# Needs: gcloud authenticated as a principal that can administer the project.
# Needs: BILLING ENABLED on the project. Without it every create below fails
# with "billing account ... is disabled in state absent" and nothing happens.
#
set -euo pipefail

PROJECT="${PROJECT:-agent-x-508719}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-agent-manager}"
BUCKET="${BUCKET:-${PROJECT}-agent-manager}"
REPO="${REPO:-containers}"
RUNTIME_SA="${RUNTIME_SA:-agent-manager-run}"
ADMINS="${BOOTSTRAP_ADMINS:-bharat.dudeja@tapcxm.com}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:$(date +%Y%m%d-%H%M%S)"
SA_EMAIL="${RUNTIME_SA}@${PROJECT}.iam.gserviceaccount.com"

say () { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Project ${PROJECT}, region ${REGION}"
gcloud config set project "$PROJECT" >/dev/null

say "Enabling APIs"
gcloud services enable \
  run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  storage.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com

say "Artifact Registry repo ${REPO}"
gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO" \
    --repository-format=docker --location="$REGION" \
    --description="Container images"

say "Storage bucket gs://${BUCKET}"
# Cloud Run has no disk that survives a revision, so STORAGE_DRIVER=fs would
# lose the log on every deploy. The GCS driver reads Application Default
# Credentials, so the runtime service account below is the only credential.
gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://${BUCKET}" \
    --location="$REGION" --uniform-bucket-level-access

say "Runtime service account ${SA_EMAIL}"
# Deliberately NOT the deploy identity. This one can read its bucket and its
# two secrets, and nothing else in the project.
gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$RUNTIME_SA" \
    --display-name="Agent Manager (Cloud Run runtime)"

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" --role=roles/storage.objectAdmin >/dev/null

say "Secrets"
# Created once with a random value and never printed by a later run. To rotate,
# add a new version by hand; the service reads :latest.
ensure_secret () {
  local name="$1"
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy=automatic >/dev/null
    openssl rand -hex 24 | gcloud secrets versions add "$name" --data-file=- >/dev/null
    echo "  created $name"
  else
    echo "  $name exists, left alone"
  fi
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role=roles/secretmanager.secretAccessor >/dev/null
}
ensure_secret agent-manager-internal-token
ensure_secret agent-manager-service-api-key

say "Building ${IMAGE}"
gcloud builds submit --config=deploy/cloudbuild.yaml --substitutions=_IMAGE="$IMAGE" .

say "Deploying ${SERVICE}"
# --max-instances=1 is not a cost setting. The store does read-modify-write
# against blob storage, which has no compare-and-swap here, so two instances
# writing the same projection can lose one of the writes. Raising this needs
# that dealt with first.
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --service-account="$SA_EMAIL" \
  --allow-unauthenticated \
  --max-instances=1 \
  --memory=1Gi \
  --set-env-vars="STORAGE_DRIVER=gcs,STORAGE_BUCKET=${BUCKET},DASHBOARD_REQUIRE_IDENTITY=true,BOOTSTRAP_ADMINS=${ADMINS}" \
  --set-secrets="INTERNAL_TOKEN=agent-manager-internal-token:latest,SERVICE_API_KEY=agent-manager-service-api-key:latest"

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"

say "Deployed"
echo "  $URL"
echo
echo "  health:  curl -s ${URL}/healthz     # expect {\"ok\":true,\"storage\":\"gcs\"}"
echo
echo "  The service API key, when the harness needs it:"
echo "    gcloud secrets versions access latest --secret=agent-manager-service-api-key"
echo
echo "  Next: create the first login, see docs/DEPLOY-GCP.md."
