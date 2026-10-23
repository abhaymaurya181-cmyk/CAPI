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

# Secrets (paste values when prompted; use `echo -n <val> | gcloud secrets create ... --data-file=-` for scripted)
for s in ADMIN_TOKEN INTERNAL_TOKEN \
         META_PIXEL_ID META_CAPI_ACCESS_TOKEN \
         GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_LOGIN_CUSTOMER_ID \
         GOOGLE_ADS_CONVERSION_ACTION_OFFLINE; do
  gcloud secrets create "$s" --replication-policy=automatic
done

# Grant Cloud Run service account access to secrets + Firestore.
# Replace PROJECT_NUMBER (see `gcloud projects describe $PROJECT_ID`).
SA="PROJECT_NUMBER-compute@developer.gserviceaccount.com"
for s in ADMIN_TOKEN INTERNAL_TOKEN \
         META_PIXEL_ID META_CAPI_ACCESS_TOKEN \
         GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_LOGIN_CUSTOMER_ID \
         GOOGLE_ADS_CONVERSION_ACTION_OFFLINE; do
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
cd deploy
PROJECT_ID="$PROJECT_ID" bash cloud-run.sh
```

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
