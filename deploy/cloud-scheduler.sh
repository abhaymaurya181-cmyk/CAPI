#!/usr/bin/env bash
# Create a Cloud Scheduler job that calls /internal/retry-sweep every 5 min.
# Run once after the first Cloud Run deploy. Idempotent via `update` fallback.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?PROJECT_ID is required}"
REGION="${REGION:-asia-south1}"
SERVICE_NAME="${SERVICE_NAME:-lucira-capi}"
JOB_NAME="${JOB_NAME:-lucira-capi-retry-sweep}"
SCHEDULE="${SCHEDULE:-*/5 * * * *}"
TZ="${SCHEDULER_TZ:-Asia/Kolkata}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" --region "${REGION}" \
  --format 'value(status.url)')"

INTERNAL_TOKEN="$(gcloud secrets versions access latest \
  --project "${PROJECT_ID}" --secret INTERNAL_TOKEN)"

TARGET_URL="${SERVICE_URL}/internal/retry-sweep"

echo "Target: ${TARGET_URL} (every ${SCHEDULE} ${TZ})"

if gcloud scheduler jobs describe "${JOB_NAME}" \
     --project "${PROJECT_ID}" --location "${REGION}" >/dev/null 2>&1; then
  echo "Updating existing job ${JOB_NAME}"
  gcloud scheduler jobs update http "${JOB_NAME}" \
    --project "${PROJECT_ID}" --location "${REGION}" \
    --schedule "${SCHEDULE}" --time-zone "${TZ}" \
    --uri "${TARGET_URL}" --http-method POST \
    --headers "Authorization=Bearer ${INTERNAL_TOKEN},Content-Type=application/json" \
    --message-body "{}"
else
  echo "Creating job ${JOB_NAME}"
  gcloud scheduler jobs create http "${JOB_NAME}" \
    --project "${PROJECT_ID}" --location "${REGION}" \
    --schedule "${SCHEDULE}" --time-zone "${TZ}" \
    --uri "${TARGET_URL}" --http-method POST \
    --headers "Authorization=Bearer ${INTERNAL_TOKEN},Content-Type=application/json" \
    --message-body "{}"
fi
