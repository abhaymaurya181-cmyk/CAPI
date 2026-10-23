# lucira-capi

Server-side offline conversion tracking for Lucira Jewellery. Matches store (OrnaVerse) sales to website visitors who came from Meta / Google ads, and sends them to Meta Conversions API and Google Ads.

## Architecture

- **Fastify + TypeScript** backend on Cloud Run
- **Firestore** for `visitors` + `conversions_log`
- **Cloud Tasks** for retry queue
- **Admin UI** at `/admin` (same backend, static Next.js build)

## Routes

| Route | Purpose |
|---|---|
| `POST /identify` | GTM tag posts user identity + click IDs |
| `POST /webhook/ornaverse` | OrnaVerse offline sales |
| `POST /admin/api/upload/offline-sales` | Admin CSV upload fallback for offline sales |
| `POST /internal/sync-offline` | Scheduled OrnaVerse pull → match → send (Cloud Scheduler, `INTERNAL_TOKEN`) |
| `POST /internal/retry-sweep` | Re-send conversions whose retry is due (Cloud Scheduler, `INTERNAL_TOKEN`) |
| `GET /admin/api/sync-runs` | Sync log |
| `GET /admin/*` | Admin UI (auth required) |
| `GET /health` | Health check |

## Dev

```sh
cp .env.example .env
npm install
npm run dev
```

## Deploy

Cloud Run (asia-south1). See `deploy/README.md` once added.
