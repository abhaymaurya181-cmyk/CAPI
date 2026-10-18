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
  cloudscheduler.googleapis.com

# Artifact Registry (image repo)
gcloud artifacts repositories create lucira-capi \
  --repository-format=docker --location="$REGION"

# Firestore (Native mode)
gcloud firestore databases create --location="$REGION"

# Secrets (paste values when prompted; use `echo -n <val> | gcloud secrets create ... --data-file=-` for scripted)
for s in ADMIN_TOKEN INTERNAL_TOKEN SHOPIFY_WEBHOOK_SECRET \
         META_PIXEL_ID META_CAPI_ACCESS_TOKEN \
         GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_DEVELOPER_TOKEN \
         GOOGLE_ADS_LOGIN_CUSTOMER_ID GOOGLE_ADS_CLIENT_ID \
         GOOGLE_ADS_CLIENT_SECRET GOOGLE_ADS_REFRESH_TOKEN \
         GOOGLE_ADS_CONVERSION_ACTION_ONLINE GOOGLE_ADS_CONVERSION_ACTION_OFFLINE; do
  gcloud secrets create "$s" --replication-policy=automatic
done

# Grant Cloud Run service account access to secrets + Firestore.
# Replace PROJECT_NUMBER (see `gcloud projects describe $PROJECT_ID`).
SA="PROJECT_NUMBER-compute@developer.gserviceaccount.com"
for s in ADMIN_TOKEN INTERNAL_TOKEN SHOPIFY_WEBHOOK_SECRET \
         META_PIXEL_ID META_CAPI_ACCESS_TOKEN \
         GOOGLE_ADS_CUSTOMER_ID GOOGLE_ADS_DEVELOPER_TOKEN \
         GOOGLE_ADS_LOGIN_CUSTOMER_ID GOOGLE_ADS_CLIENT_ID \
         GOOGLE_ADS_CLIENT_SECRET GOOGLE_ADS_REFRESH_TOKEN \
         GOOGLE_ADS_CONVERSION_ACTION_ONLINE GOOGLE_ADS_CONVERSION_ACTION_OFFLINE; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
done
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA" --role=roles/datastore.user
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

- Set the Shopify webhook URL in Lucira's custom app → `<url>/webhook/shopify`
- Point the DNS CNAME `track.lucirajewelry.com` → the service URL via Cloud Run domain mapping (`gcloud run domain-mappings create`)
- Open `<url>/admin/` and sign in with `ADMIN_TOKEN`

## Scheduled retry sweep

```sh
PROJECT_ID="$PROJECT_ID" bash cloud-scheduler.sh
```

Default: every 5 minutes, Asia/Kolkata timezone. Change `SCHEDULE` env var to adjust.

## Smoke tests

```sh
SERVICE_URL="$(gcloud run services describe lucira-capi --region=$REGION --format='value(status.url)')"

# Health
curl -s "$SERVICE_URL/healthz"

# Admin stats (needs ADMIN_TOKEN)
curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" "$SERVICE_URL/admin/api/stats"

# Shopify webhook (will 401 — HMAC-signed test is in docs)
curl -s -X POST "$SERVICE_URL/webhook/shopify" -H "Content-Type: application/json" -d '{}'
```
