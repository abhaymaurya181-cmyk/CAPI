#!/usr/bin/env bash
# Build + deploy lucira-capi to Cloud Run (asia-south1).
# Assumes gcloud is authenticated and project is set.
#
# Required env (from .env or shell):
#   PROJECT_ID             GCP project
#   REGION                 asia-south1 (default)
#   SERVICE_NAME           lucira-capi (default)
#
# Secrets must already exist in Secret Manager:
#   ADMIN_TOKEN, INTERNAL_TOKEN,
#   META_PIXEL_ID, META_CAPI_ACCESS_TOKEN,
#   GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_DEVELOPER_TOKEN,
#   GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_CLIENT_ID,
#   GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN,
#   GOOGLE_ADS_CONVERSION_ACTION_ONLINE, GOOGLE_ADS_CONVERSION_ACTION_OFFLINE

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?PROJECT_ID is required}"
REGION="${REGION:-asia-south1}"
SERVICE_NAME="${SERVICE_NAME:-lucira-capi}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/lucira-capi/${SERVICE_NAME}:latest"

echo "Building image: ${IMAGE}"
gcloud builds submit \
  --project "${PROJECT_ID}" \
  --tag "${IMAGE}" \
  ..

echo "Deploying to Cloud Run"
gcloud run deploy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --concurrency 80 \
  --min-instances 0 \
  --max-instances 10 \
  --set-env-vars "NODE_ENV=production,GOOGLE_CLOUD_PROJECT=${PROJECT_ID}" \
  --set-secrets "ADMIN_TOKEN=ADMIN_TOKEN:latest,\
INTERNAL_TOKEN=INTERNAL_TOKEN:latest,\
META_PIXEL_ID=META_PIXEL_ID:latest,\
META_CAPI_ACCESS_TOKEN=META_CAPI_ACCESS_TOKEN:latest,\
GOOGLE_ADS_CUSTOMER_ID=GOOGLE_ADS_CUSTOMER_ID:latest,\
GOOGLE_ADS_DEVELOPER_TOKEN=GOOGLE_ADS_DEVELOPER_TOKEN:latest,\
GOOGLE_ADS_LOGIN_CUSTOMER_ID=GOOGLE_ADS_LOGIN_CUSTOMER_ID:latest,\
GOOGLE_ADS_CLIENT_ID=GOOGLE_ADS_CLIENT_ID:latest,\
GOOGLE_ADS_CLIENT_SECRET=GOOGLE_ADS_CLIENT_SECRET:latest,\
GOOGLE_ADS_REFRESH_TOKEN=GOOGLE_ADS_REFRESH_TOKEN:latest,\
GOOGLE_ADS_CONVERSION_ACTION_ONLINE=GOOGLE_ADS_CONVERSION_ACTION_ONLINE:latest,\
GOOGLE_ADS_CONVERSION_ACTION_OFFLINE=GOOGLE_ADS_CONVERSION_ACTION_OFFLINE:latest"

echo "Service URL:"
gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" --region "${REGION}" \
  --format 'value(status.url)'
