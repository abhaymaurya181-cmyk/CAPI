# Deploy — lucira-capi

Deploy target: Google Cloud, asia-south1.

**One script for everyone:** `deploy/deploy.mjs` runs the same on Windows (PowerShell / cmd),
Linux and macOS. Every command below is a single line that works in all of them. If you change
how we deploy, change `deploy.mjs` (and this file) — there is no second OS-specific copy.

Needs: Node 22+, the gcloud CLI logged in (`gcloud auth login`), and — for indexes — the
firebase CLI. Replace `<project-id>` with the Google Cloud project id everywhere.

## One-time setup

```sh
gcloud config set project <project-id>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com datamanager.googleapis.com
gcloud artifacts repositories create lucira-capi --repository-format=docker --location=asia-south1
gcloud firestore databases create --location=asia-south1
```

### Secrets

Store each secret **with its value**, only once you have the value. The script asks for it
hidden — it never appears on screen, in shell history or in the command line. Running it again
for an existing secret adds a new version (that's how you change a value).

```sh
node deploy/deploy.mjs secret LUCIRA_CREDS_CAPI --project <project-id>
node deploy/deploy.mjs secret INTERNAL_TOKEN --project <project-id>
```

`INTERNAL_TOKEN`: letters, digits, `-` and `_` only (it goes into a scheduler header).

Optional — add each when you have the value; the service switches that integration on at the
next deploy:

| Integration | Secrets |
|---|---|
| OrnaVerse | `ORNAVERSE_API_BASE`, `ORNAVERSE_CLIENT_ID`, `ORNAVERSE_CLIENT_SECRET` |
| Meta | `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN` |
| Google | `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_CONVERSION_ACTION_PURCHASE` |
| Google manager account | `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (only if the Ads account sits under an MCC) |

### Access

Lets the Cloud Run service account read every secret that exists, and use Firestore.
**Re-run after adding new secrets.**

```sh
node deploy/deploy.mjs grant --project <project-id>
```

It prints the service account email. Add that email as a user (Standard access) in Google Ads →
Admin → Access and security, on the account that owns the conversion action (or on the manager
account set in `GOOGLE_ADS_LOGIN_CUSTOMER_ID`). Use `--service-account <email>` if Cloud Run
runs as a dedicated service account instead of the Compute default.

## Firestore indexes

```sh
cd deploy
firebase use <project-id>
firebase deploy --only firestore:indexes,firestore:rules
```

## Deploy the service

```sh
node deploy/deploy.mjs service --project <project-id> --dry-run
node deploy/deploy.mjs service --project <project-id>
```

`--dry-run` lists which secrets will be attached / are missing and the exact commands, and
changes nothing. Works from any folder.

- Only `LUCIRA_CREDS_CAPI` and `INTERNAL_TOKEN` are required. A half-configured integration is flagged.
- Non-secret settings use production defaults (`ORNAVERSE_POSTED_STATUSES=1`, `CLICK_MODE=last`,
  `GOOGLE_VALIDATE_ONLY=true`, … — see `SETTINGS` in `deploy.mjs`). Override one with an
  environment variable for that run:
  - PowerShell: `$env:GOOGLE_VALIDATE_ONLY="false"; node deploy/deploy.mjs service --project <project-id>`
  - bash/zsh: `GOOGLE_VALIDATE_ONLY=false node deploy/deploy.mjs service --project <project-id>`
- Never set `META_TEST_EVENT_CODE` in production unless you mean to send to Meta's Test Events.
- `.gcloudignore` keeps `.env`, service-account keys and the private OrnaVerse docs out of the upload.

First deploy prints the service URL. Use it to:

- Point the DNS CNAME `track.lucirajewelry.com` → the service URL via Cloud Run domain mapping (`gcloud run domain-mappings create`)
- Open `<url>/admin/` and sign in with `LUCIRA_CREDS_CAPI`

## Scheduled jobs

```sh
node deploy/deploy.mjs scheduler --project <project-id> --dry-run
node deploy/deploy.mjs scheduler --project <project-id>
```

Run after the first service deploy (it needs the service URL). Safe to re-run: existing jobs are
updated. `all` does service + scheduler in one go. Creates three jobs (Asia/Kolkata):

- `lucira-capi-retry-sweep` → `/internal/retry-sweep`, every 5 minutes (`SCHEDULE`). Re-sends conversions whose retry is due (back-off 5m → 15m → 1h → 4h → 12h, then `failed`).
- `lucira-capi-sync-offline` → `/internal/sync-offline`, hourly (`SYNC_SCHEDULE`). Pulls new OrnaVerse sales, matches them to visitors and sends them. Every run is listed in the `sync_runs` collection; until OrnaVerse secrets exist each run is recorded as `skipped`.
- `lucira-capi-sync-offline-rescan` → `/internal/sync-offline-rescan`, daily 03:30 (`RESCAN_SCHEDULE`). Safety net: re-reads posted bills dated in the last `ORNAVERSE_RESCAN_DAYS` (default 30) and imports only ones never recorded — backdated bills, hours the hourly pull missed, drafts posted later. Shares the hourly pull's lock (keep it off the hour) and never moves its cursor. Shows as "Daily re-scan" in the admin sync log; `page_limit_reached` there means older bills were not read that day.

## Smoke tests

On Windows use `curl.exe` (in PowerShell, plain `curl` is a different command).

```sh
gcloud run services describe lucira-capi --region asia-south1 --format "value(status.url)"
curl.exe -s <service-url>/health
curl.exe -s -H "Authorization: Bearer <LUCIRA_CREDS_CAPI>" <service-url>/admin/api/stats
```
