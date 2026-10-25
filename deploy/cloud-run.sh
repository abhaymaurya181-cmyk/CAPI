#!/usr/bin/env bash
# Build + deploy lucira-capi to Cloud Run (asia-south1).
# Assumes gcloud is authenticated. Run from anywhere: bash deploy/cloud-run.sh
#
# Required env (shell):
#   PROJECT_ID             GCP project
#   REGION                 asia-south1 (default)
#   SERVICE_NAME           lucira-capi (default)
#   DRY_RUN=1              print the deploy command instead of running it
#
# Secrets (Secret Manager). Only ADMIN_TOKEN + INTERNAL_TOKEN are required.
# Every integration secret is attached only if it exists, so the service can
# go live in stages (e.g. OrnaVerse pull first, Meta/Google once their
# credentials arrive). Missing ones are listed before deploying; the app
# reports that integration as "not configured" instead of failing.
#   ORNAVERSE_API_BASE, ORNAVERSE_CLIENT_ID, ORNAVERSE_CLIENT_SECRET
#   META_PIXEL_ID, META_CAPI_ACCESS_TOKEN
#   GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_CONVERSION_ACTION_OFFLINE,
#   GOOGLE_ADS_LOGIN_CUSTOMER_ID (only if the account sits under a manager)
#
# Non-secret settings come from the shell, with production defaults below.
# Google auth uses the Cloud Run service account (no key file). That account
# must be added as a user in Google Ads. GOOGLE_VALIDATE_ONLY stays "true"
# until the validateOnly checks pass; redeploy with GOOGLE_VALIDATE_ONLY=false.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?PROJECT_ID is required}"
REGION="${REGION:-asia-south1}"
SERVICE_NAME="${SERVICE_NAME:-lucira-capi}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/lucira-capi/${SERVICE_NAME}:latest"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- secrets: required + optional ----
REQUIRED_SECRETS=(ADMIN_TOKEN INTERNAL_TOKEN)
OPTIONAL_SECRETS=(
  ORNAVERSE_API_BASE ORNAVERSE_CLIENT_ID ORNAVERSE_CLIENT_SECRET
  META_PIXEL_ID META_CAPI_ACCESS_TOKEN
  GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_CONVERSION_ACTION_OFFLINE GOOGLE_ADS_LOGIN_CUSTOMER_ID
)

# A secret counts only if it has an enabled "latest" version: a secret created
# without a value exists but would make Cloud Run fail at deploy. This reads
# metadata only, never the secret value.
secret_exists() {
  gcloud secrets versions describe latest --secret "$1" --project "${PROJECT_ID}" \
    --format 'value(state)' 2>/dev/null | grep -qx ENABLED
}

secret_pairs=()
for s in "${REQUIRED_SECRETS[@]}"; do
  if ! secret_exists "$s"; then
    echo "ERROR: required secret ${s} is missing in Secret Manager (${PROJECT_ID})." >&2
    exit 1
  fi
  secret_pairs+=("${s}=${s}:latest")
done
missing=()
for s in "${OPTIONAL_SECRETS[@]}"; do
  if secret_exists "$s"; then secret_pairs+=("${s}=${s}:latest"); else missing+=("$s"); fi
done

# An integration with only some of its secrets would fail at runtime; say so now.
check_group() {
  local name="$1"; shift
  local have=0 total=$#
  for s in "$@"; do secret_exists "$s" && have=$((have + 1)); done
  if [ "$have" -gt 0 ] && [ "$have" -lt "$total" ]; then
    echo "WARNING: ${name} is partly configured (${have}/${total} secrets): $*" >&2
  fi
}
check_group OrnaVerse ORNAVERSE_API_BASE ORNAVERSE_CLIENT_ID ORNAVERSE_CLIENT_SECRET
check_group Meta META_PIXEL_ID META_CAPI_ACCESS_TOKEN
check_group Google GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_CONVERSION_ACTION_OFFLINE
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Not attached (secret not created yet): ${missing[*]}"
fi

# ---- non-secret settings ----
# "|" delimiter (gcloud ^|^ syntax) so values may contain commas, e.g.
# ORNAVERSE_POSTED_STATUSES=1,2.
env_pairs=(
  "NODE_ENV=production"
  "GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"
  "GOOGLE_VALIDATE_ONLY=${GOOGLE_VALIDATE_ONLY:-true}"
  "ORNAVERSE_SCOPE=${ORNAVERSE_SCOPE:-openid}"
  "ORNAVERSE_POSTED_STATUSES=${ORNAVERSE_POSTED_STATUSES:-1}"
  "ORNAVERSE_INITIAL_LOOKBACK_DAYS=${ORNAVERSE_INITIAL_LOOKBACK_DAYS:-7}"
  "CLICK_MODE=${CLICK_MODE:-last}"
  "CLICK_WINDOW_DAYS=${CLICK_WINDOW_DAYS:-90}"
  "META_API_VERSION=${META_API_VERSION:-v20.0}"
  "ADMIN_USERNAME=${ADMIN_USERNAME:-admin}"
  "LOG_LEVEL=${LOG_LEVEL:-info}"
)
# Test-only: never set in production unless you mean to route events to
# Meta's Test Events screen.
if [ -n "${META_TEST_EVENT_CODE:-}" ]; then
  echo "WARNING: META_TEST_EVENT_CODE is set — Meta events go to Test Events only." >&2
  env_pairs+=("META_TEST_EVENT_CODE=${META_TEST_EVENT_CODE}")
fi
for pair in "${env_pairs[@]}"; do
  case "$pair" in *"|"*) echo "ERROR: '|' is not allowed in setting: ${pair%%=*}" >&2; exit 1 ;; esac
done

join_by() { local IFS="$1"; shift; echo "$*"; }
ENV_ARG="^|^$(join_by "|" "${env_pairs[@]}")"
SECRETS_ARG="$(join_by "," "${secret_pairs[@]}")"

deploy_cmd=(
  gcloud run deploy "${SERVICE_NAME}"
  --project "${PROJECT_ID}"
  --region "${REGION}"
  --image "${IMAGE}"
  --platform managed
  --allow-unauthenticated
  --port 8080
  --memory 512Mi
  --cpu 1
  --concurrency 80
  --min-instances 0
  --max-instances 10
  --set-env-vars "${ENV_ARG}"
  --set-secrets "${SECRETS_ARG}"
)

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "DRY RUN — would build ${IMAGE} from ${REPO_ROOT} and run:"
  printf '%q ' "${deploy_cmd[@]}"; echo
  exit 0
fi

echo "Building image: ${IMAGE}"
gcloud builds submit \
  --project "${PROJECT_ID}" \
  --tag "${IMAGE}" \
  "${REPO_ROOT}"

echo "Deploying to Cloud Run"
"${deploy_cmd[@]}"

echo "Service URL:"
gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" --region "${REGION}" \
  --format 'value(status.url)'
