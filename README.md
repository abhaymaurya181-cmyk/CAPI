# lucira-capi

Server-side conversion tracking for Lucira Jewellery. Sends online + offline sales to Meta Conversions API and Google Ads.

## Architecture

- **Fastify + TypeScript** backend on Cloud Run
- **Firestore** for `visitors` + `conversions_log`
- **Cloud Tasks** for retry queue
- **Admin UI** at `/admin` (same backend, static Next.js build)

## Routes

| Route | Purpose |
|---|---|
| `POST /identify` | GTM tag posts user identity + click IDs |
| `POST /webhook/shopify` | Shopify `orders/create` webhook (HMAC verified) |
| `POST /webhook/ornaverse` | OrnaVerse offline sales |
| `POST /upload/csv` | Admin CSV upload fallback for offline sales |
| `GET /admin/*` | Admin UI (auth required) |
| `GET /healthz` | Health check |

## Dev

```sh
cp .env.example .env
npm install
npm run dev
```

## Deploy

Cloud Run (asia-south1). See `deploy/README.md` once added.
