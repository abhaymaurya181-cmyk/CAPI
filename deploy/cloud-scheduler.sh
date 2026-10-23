#!/usr/bin/env bash
# Create the Cloud Scheduler jobs:
#   - retry sweep:  /internal/retry-sweep  every 5 min (SCHEDULE)
#   - offline sync: /internal/sync-offline hourly (SYNC_SCHEDULE)
# Run once after the first Cloud Run deploy. Idempotent via `update` fallback.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?PROJECT_ID is required}"
REGION="${REGION:-asia-south1}"
SERVICE_NAME="${SERVICE_NAME:-lucira-capi}"
SCHEDULE="${SCHEDULE:-*/5 * * * *}"
SYNC_SCHEDULE="${SYNC_SCHEDULE:-0 * * * *}"
TZ="${SCHEDULER_TZ:-Asia/Kolkata}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" --region "${REGION}" \
  --format 'value(status.url)')"

INTERNAL_TOKEN="$(gcloud secrets versions access latest \
  --project "${PROJECT_ID}" --secret INTERNAL_TOKEN)"

# upsert_job NAME SCHEDULE PATH
upsert_job() {
  local name="$1" schedule="$2" path="$3"
  local target="${SERVICE_URL}${path}"
  local verb="create"
  if gcloud scheduler jobs describe "${name}" \
       --project "${PROJECT_ID}" --location "${REGION}" >/dev/null 2>&1; then
    verb="update"
  fi
  echo "${verb} ${name}: ${target} (${schedule} ${TZ})"
  gcloud scheduler jobs "${verb}" http "${name}" \
    --project "${PROJECT_ID}" --location "${REGION}" \
    --schedule "${schedule}" --time-zone "${TZ}" \
    --uri "${target}" --http-method POST \
    --attempt-deadline 600s \
    --headers "Authorization=Bearer ${INTERNAL_TOKEN},Content-Type=application/json" \
    --message-body "{}"
}

upsert_job "${SERVICE_NAME}-retry-sweep" "${SCHEDULE}" "/internal/retry-sweep"
upsert_job "${SERVICE_NAME}-sync-offline" "${SYNC_SCHEDULE}" "/internal/sync-offline"
