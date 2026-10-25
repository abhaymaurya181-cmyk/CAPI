# Deploy — lucira-capi

Deploy target: Google Cloud, asia-south1.

## One-time setup

```sh
PROJECT_ID=your-gcp-project
REGION=asia-south1
gcloud config set project "$PROJECT_ID"

# Enable services
gcloud services enable run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  datamanager.googleapis.com

# Artifact Registry (image repo)
gcloud artifacts repositories create lucira-capi \
  --repository-format=docker --location="$REGION"

# Firestore (Native mode)
gcloud firestore databases create --location="$REGION"

# Secrets. Create each one WITH its value, only once you have the value
# (a secret without a value breaks the deploy). The value is typed hidden and
# never lands in shell history. Required: ADMIN_TOKEN, INTERNAL_TOKEN.
# Optional, add when available (deploy attaches whichever exist):
#   ORNAVERSE_API_BASE ORNAVERSE_CLIENT_ID ORNAVERSE_CLIENT_SECRET
#   META_PIXEL_ID META_CAPI_ACCESS_TOKEN
#   GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_CONVERSION_ACTION_OFFLINE
#   GOOGLE_ADS_LOGIN_CUSTOMER_ID   (only if the Ads account sits under a manager)
add_secret() {
  read -rsp "Value for $1: " val; echo
  printf '%s' "$val" | gcloud secrets create "$1" --replication-policy=automatic --data-file=- \
    || printf '%s' "$val" | gcloud secrets versions add "$1" --data-file=-   # already exists → new version
  unset val
}
add_secret ADMIN_TOKEN
add_secret INTERNAL_TOKEN
# ...repeat add_secret for each optional secret above when you have its value.

# Grant the Cloud Run service account access to every secret + Firestore.
# Replace PROJECT_NUMBER (see `gcloud projects describe $PROJECT_ID`).
# Re-run the loop after adding new secrets.
SA="PROJECT_NUMBER-compute@developer.gserviceaccount.com"
for s in $(gcloud secrets list --format='value(name)'); do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
done
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA" --role=roles/datastore.user

# Google Ads (Data Manager API): in Google Ads → Admin → Access and security,
# add $SA as a user (Standard access) on the account that owns the conversion
# action, or on the manager account set in GOOGLE_ADS_LOGIN_CUSTOMER_ID.
```

## Firestore indexes

```sh
# Using firebase CLI (easiest). Requires `firebase login`.
cd deploy
firebase use "$PROJECT_ID"
firebase deploy --only firestore:indexes,firestore:rules
```

## Deploy the service

```sh
# Check first: lists which secrets will be attached / are missing, and the
# exact deploy command. Builds and changes nothing.
PROJECT_ID="$PROJECT_ID" DRY_RUN=1 bash deploy/cloud-run.sh

PROJECT_ID="$PROJECT_ID" bash deploy/cloud-run.sh
```

Works from any folder. Only `ADMIN_TOKEN` and `INTERNAL_TOKEN` are required; each
integration (OrnaVerse, Meta, Google) switches on once its secrets exist — redeploy
after adding them. A half-configured integration is flagged before deploying.
Non-secret settings use production defaults (`ORNAVERSE_POSTED_STATUSES=1`,
`CLICK_MODE=last`, `GOOGLE_VALIDATE_ONLY=true`, …); override by setting them in the
shell, e.g. `GOOGLE_VALIDATE_ONLY=false bash deploy/cloud-run.sh`.
Never set `META_TEST_EVENT_CODE` in production unless you mean to send to Test Events.

First deploy prints the service URL. Use it to:

- Point the DNS CNAME `track.lucirajewelry.com` → the service URL via Cloud Run domain mapping (`gcloud run domain-mappings create`)
- Open `<url>/admin/` and sign in with `ADMIN_TOKEN`

## Scheduled jobs

```sh
PROJECT_ID="$PROJECT_ID" bash cloud-scheduler.sh
```

Creates two jobs (Asia/Kolkata):

- `lucira-capi-retry-sweep` → `/internal/retry-sweep`, every 5 minutes (`SCHEDULE`). Re-sends conversions whose retry is due (back-off 5m → 15m → 1h → 4h → 12h, then `failed`).
- `lucira-capi-sync-offline` → `/internal/sync-offline`, hourly (`SYNC_SCHEDULE`). Pulls new OrnaVerse sales, matches them to visitors and sends them. Every run is listed in the `sync_runs` collection; until the OrnaVerse importer is set up each run is recorded as `skipped`.

## Smoke tests

```sh
SERVICE_URL="$(gcloud run services describe lucira-capi --region=$REGION --format='value(status.url)')"

# Health
curl -s "$SERVICE_URL/health"

# Admin stats (needs ADMIN_TOKEN)
curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" "$SERVICE_URL/admin/api/stats"
```
