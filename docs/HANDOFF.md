# Handoff — Lucira offline CAPI (as of 2026-10-24, after commit 4c55021)

Read this first when continuing on a new machine / new Claude session.

## ⚠️ Hard rules (read before touching OrnaVerse)

1. **OrnaVerse is PRODUCTION only** (`https://lucira.live.ornaverse.in`). There is **no test server**
   for us (`test.ornaverse.in` in their docs is not ours). Treat every call as touching live business data.
2. **Read-only, strictly.** Every OrnaVerse endpoint is HTTP `POST`, even reads — so the rule is about the
   *action*, not the HTTP method:
   - ✅ Allowed: `POST /connect/token` (auth), `POST /Services/POS/Invoice/List`,
     `POST /Services/POS/Invoice/Retrieve`, `POST /Services/POS/Customer/List|Retrieve`.
     Later maybe `WebhookSubscriptions/List`, `SamplePayload`, `ListIntegrationEntityTypes` — confirm each
     is really a read before calling.
   - ❌ Never: any `Create`, `Update`, `Delete`, `Post`, `Cancel`, `ApplyAdditionalDiscount`,
     `PostToShopify`, `UpdateInsurance`, `GeneratePDF`, anything under `Administration` that writes —
     **including `WebhookSubscriptions/Create`**. If a webhook is needed, the OrnaVerse team creates it.
   - Keep reads small (`Take` 1–5 for checks) and **ask the user before every live call**.
3. **Secrets:** OrnaVerse client id/secret belong to Lucira and **cannot be rotated** by us.
   - They live only in `.env` (gitignored). Never in `.env.example`, never in code, never in chat/logs.
   - **Do not open/print `.env`** (the user asked for this). Scripts may load it via `dotenv` without
     printing values. If you must check a value exists, print `set` / `MISSING` only.
   - On a new laptop, the user creates `.env` by hand; nothing secret is in git.
4. **Customer data (PII):** when printing OrnaVerse rows, show only non-PII fields
   (`transaction_id`, dates, `document_status`, amounts, store) — mask names, phones, emails, addresses.
   Never commit real rows.

## What this project is

A customer clicks a Meta/Google ad → lands on lucirajewelry.com → logs in / signs up
(phone + email) but buys nothing online → later buys in a Lucira **store**.
We match that store sale (OrnaVerse POS) to the website visitor by phone/email and
send the sale to **Meta Conversions API** (`physical_store`) and **Google Ads via the
Data Manager API**, with the original ad click id, so ads get credit for store sales.

The repo is **offline-only** (the Shopify online-order webhook was removed). Firestore only.

## Status

| Step | State |
|---|---|
| 1 Tracker + `/identify`: first + last click per platform, all Meta/Google cookies, `CLICK_MODE` | ✅ done |
| 1b Remove Shopify webhook | ✅ done |
| 2 Phone/email/name normalization + unit tests | ✅ done |
| 3 Meta sender (`physical_store`, 62-day limit, test-event script) | ✅ done — not yet tested live (no Meta creds) |
| 4 Google sender on Data Manager API (`validateOnly`) | ✅ done — not yet tested live (no Google creds) |
| 6 Matcher, sync log, hourly sync job, retry back-off | ✅ done |
| 7 Admin: sync-log page, match details, resend, payload preview (dry-run), IP geo | ✅ done |
| 8 CSV upload route (uses same matcher) | ✅ route done; upload **page** deferred by user |
| **5a OrnaVerse hourly pull** (`src/importers/ornaverse.ts`) | 🟡 **works against live tenant** (token + list verified); has open issues below |
| **5b OrnaVerse webhook** (`src/routes/webhook-ornaverse.ts`) | ❌ still a stub — user chose this as the main path ("Method B") |
| Live Meta / Google tests | ❌ waiting for credentials |
| Deploy (Cloud Run, scheduler, indexes, domain, GTM) | ❌ not done |

`npm test` → 59 passing. `npm run typecheck` clean.

## OrnaVerse — verified facts (live tenant, commit 4c55021)

- Base: `https://lucira.live.ornaverse.in` (strip trailing slash — `//connect/token` → 404).
- Auth: `POST /connect/token`, form-encoded, `grant_type=client_credentials`, `client_id`, `client_secret`,
  **`scope=openid`** (OpenIddict; without scope → `400 invalid_scope "Request must contain scope."`).
  `/.well-known/openid-configuration` is 404 (not published).
- Data: `POST /Services/POS/Invoice/List` with Bearer token. Body = Serenity ListRequest
  (`Skip`, `Take`, `EqualityFilter`, …). Response `{ Entities, TotalCount, Skip, Take, Error }`.
- Quirks:
  - **Any `Sort` clause → HTTP 500.** Default order is newest first (`transaction_id` DESC).
  - **Unknown field in `EqualityFilter` → HTTP 500.** Only use documented fields.
  - `document_status`: **1 = posted (~97%)**, **2 = returns/cancels (~3%)** — exact meaning of 2 unconfirmed.
    `EqualityFilter: { document_status: 1 }` works server-side.
  - ~2010 invoices total visible; last 24h returned 7 real sales (Delhi / Paschim Vihar / Borivali).
- Field mapping (`mapInvoiceRow`): sale_id = `transaction_id`; event_time = `document_date` (treated as IST
  if no offset); amount = `net_amount`; phone = `phone_code` + `mobile`; `email`; name = `party_name`
  (split first/last); `shipping_city/state/pin_code`; store = `mailing_name` || `company_name`; currency INR.
- Other useful endpoints (read): `POS > Customer` (birth_date, gender, pin_code — optional enrichment),
  `POS > Invoice > GetPOSSales` (invoices + returns in one feed — maybe for returns later).
- Webhook endpoints exist in the docs: `Administration > WebhookSubscriptions` (Create, List,
  `SamplePayload`, `ListIntegrationEntityTypes`), `Administration > DocumentsWebhooks`, and a
  `WebhookDeliveriesRow` schema (suggests a delivery log / retries).

Private OrnaVerse docs are in `ornaverse-api-docs/` (`api-dog.txt` index + `api-dog-pages/`), **gitignored**
— copy that folder to the new laptop manually. Online: https://ornaverse-advantage.apidog.io (password —
ask the team; not stored in repo).

Scripts (both read-only, load `.env` via dotenv):
- `node scripts/orna-smoke.mjs` — token + several `Invoice/List` probes (prints ids/dates/status/store only).
- `npx tsx scripts/orna-importer-live.mjs` — runs real `fetchOrnaverseSales()` for the last 24h.
Ask the user before running either (production).

## Open issues in the OrnaVerse pull (fix before go-live — wait for user's "go")

1. **Backdated bills are missed (most important).** InvoiceRow has `allow_backdated_entry` /
   `number_of_backdated_days`, so staff can enter a bill today with an older `document_date`. The importer
   windows by `document_date`, so such a bill falls before the hourly window → **skipped forever**, and one
   such row also stops paging early. Fix idea: window/stop on `creation_date` (or `modification_date`)
   — when the bill was entered — instead of `document_date`. Duplicates are already blocked by sale id.
2. **Unverified: does `document_date` carry a real time or only the date (midnight)?** If date-only,
   hourly windows break. Planned check (user has NOT approved yet): one read-only call, token +
   `Invoice/List` `Take: 5`, print only `transaction_id`, `document_date`, `creation_date`,
   `modification_date`, `document_status`.
3. **Risky default:** if `ORNAVERSE_POSTED_STATUSES` is unset, *all* statuses are imported (incl. 2).
   Code should default to `1` (or import nothing).
4. **Status 2 meaning:** separate return/cancel document, or the original bill flipped 1 → 2? If the
   original flips after we sent it, decide: skip, or send a correction to Meta/Google.
5. Smaller:
   - Admin payload preview (`src/routes/admin-api.ts`, `previewPayloads`) shows the wrong Google endpoint
     (`audiencePartners/...:ingestEvents`); real sender uses `https://datamanager.googleapis.com/v1/events:ingest`.
     Label only.
   - Webhook stub logs the full request body → raw phone/email in logs. Fix when building 5b.
   - One person can have two visitor docs (keyed phone → email → user_id); matcher takes the first found.
   - Store-bill email matching uses the Meta-format hash; `email_google_hash` would also catch gmail dot variants.
   - Conversions created before step 6 have no `next_retry_at`, so the retry sweep never picks them up.
   - Phone: if `mobile` ever already includes `91`, `joinPhone` would double the country code — check on data.

## Webhook (step 5b, "Method B") — agreed direction

- **Why:** OrnaVerse pushes each posted bill to us within seconds; no paging tricks. The hourly pull stays
  as backup. Both go through the same `ingestSale`; duplicates blocked by sale id.
- **We do not create the subscription** (read-only rule) — we give OrnaVerse our URL
  (`https://<cloud-run-or-track-domain>/webhook/ornaverse`) and their team sets it up.
- Need before building:
  1. Export doc pages into `ornaverse-api-docs/api-dog-pages/` (open in browser with docs password →
     Ctrl+A, Ctrl+C → paste to a .txt):
     - WebhookSubscriptions **SamplePayload** ⭐ https://ornaverse-advantage.apidog.io/samplepayload-45759418e0.md
     - WebhookSubscriptions Create https://ornaverse-advantage.apidog.io/create-41876544e0.md
     - WebhookSubscriptions ListIntegrationEntityTypes https://ornaverse-advantage.apidog.io/listintegrationentitytypes-41876549e0.md
     - Schema WebhookSubscriptionsRow https://ornaverse-advantage.apidog.io/administration-webhooksubscriptionsrow-17081944d0.md
     - DocumentsWebhooks Create https://ornaverse-advantage.apidog.io/create-41876316e0.md
  2. Ask OrnaVerse: payload shape; how requests are signed (header/secret); which event (invoice posted?);
     do they send cancel/return events; do they retry on failure and how often; will their team create the
     subscription.
- Build: verify signature → map payload (reuse `mapInvoiceRow` if same shape) → `ingestSale` → dispatch;
  log no PII; return 2xx fast.

## Questions for Lucira / OrnaVerse (still open)

- Exact meaning of `document_status = 2` (return vs cancel; new doc vs flipped original).
- Timezone of `document_date` (assumed IST).
- Webhook questions above.
- Business decisions (user): returns/cancels after we sent → skip or correct? Exchange bills (old gold) →
  net amount or full bill value?

## Env

`.env` (gitignored, user fills it by hand on each machine). OrnaVerse:
```
ORNAVERSE_API_BASE=https://lucira.live.ornaverse.in
ORNAVERSE_CLIENT_ID=<from Lucira>
ORNAVERSE_CLIENT_SECRET=<from Lucira>
ORNAVERSE_SCOPE=openid
ORNAVERSE_POSTED_STATUSES=1
```
Note: the `.env` on the first laptop was copied from an older template — make sure the last two lines exist.
In Cloud Run use Secret Manager for client id/secret.

Meta: `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `META_TEST_EVENT_CODE` → `npm run meta:test -- [phone] [email]`.
Google: `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_CONVERSION_ACTION_OFFLINE`, optional
`GOOGLE_ADS_LOGIN_CUSTOMER_ID`, ADC credentials; service account added as a user in Google Ads;
`GOOGLE_VALIDATE_ONLY=true` until tested → `npm run google:validate -- [phone] [email] [gclid]`.
(Open question: Google example uses `eventSource` WEB; we send IN_STORE — one-line change if rejected.)

## Next actions (in order)

1. User decides on the read-only date check (issue 2) → run it if approved.
2. On "go": fix issues 1 + 3 (and 2 if needed) with tests; show the user before committing.
3. Webhook pages + OrnaVerse answers → build 5b.
4. Meta + Google creds → Meta test event, Google validateOnly → one OrnaVerse bill end to end.
5. Deploy: Cloud Run + env/secrets, `node deploy/deploy.mjs all` (see deploy/README.md), Firestore indexes, service account in
   Google Ads, `track.lucirajewelry.com`, tracker on site via GTM.
6. Set `GOOGLE_VALIDATE_ONLY=false` → live.
7. Later: returns/corrections, CSV upload page, fix "smaller" issues.

## Git / GitHub access (Windows laptop notes)

- Repo `abhaymaurya181-cmyk/CAPI` (private). The `Maroof-56` GitHub account has **no access**
  ("Repository not found"). Use the `abhaymaurya181-cmyk` account: `gh auth switch -u abhaymaurya181-cmyk`.
- If git still uses cached Maroof-56 credentials, pull/push with:
  `git -c credential.helper= -c credential.helper='!gh auth git-credential' pull`
- Don't use another account's token without the user saying so.

## How the user wants to work

- Discuss and explain simply first; **no code changes until the user says go**.
- Small steps; show what was built + how it was verified; commit only when asked; push when asked.
- Research-based decisions (check Meta/Google official docs), check edge cases.
- OrnaVerse: read-only, small, ask before each live call (see Hard rules).
