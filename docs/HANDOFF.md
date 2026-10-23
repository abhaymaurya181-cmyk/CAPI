# Handoff — Lucira offline CAPI (as of 2026-10-24)

Read this first when continuing on a new machine / new Claude session.

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
| 3 Meta sender (`physical_store`, 62-day limit, test-event script) | ✅ done |
| 4 Google sender on Data Manager API (`validateOnly`) | ✅ done |
| 6 Matcher, sync log, hourly sync job, retry back-off | ✅ done |
| 7 Admin: sync-log page, match details, resend | ✅ done |
| 8 CSV upload (uses same matcher) | ✅ done — low priority |
| **5 OrnaVerse importer** | ❌ **the only core piece left** |

`npm test` → 41 passing. `npm run typecheck` clean.

After step 5: add credentials → test (Meta test event, Google validateOnly, one OrnaVerse
bill end-to-end) → deploy (Cloud Run, scheduler, indexes, service account in Google Ads,
`track.lucirajewelry.com`, tracker on site via GTM) → set `GOOGLE_VALIDATE_ONLY=false`.

## OrnaVerse — what we found in their API docs

Docs: https://ornaverse-advantage.apidog.io (password-protected — ask the team for the
password; it is **not** stored in this repo). Local copies live in `api-dog.txt` (index)
and `api-dog-pages/` (page exports). Both are **gitignored** (private vendor docs) — copy
them to the new laptop manually if needed.

- Test server: `https://test.ornaverse.in`. Every call is `POST /Services/<Module>/<Entity>/<Action>`.
- Auth: JWT Bearer from `POST /connect/token`, OAuth **client_credentials** (ApiClient).
  The token page is **not** in the docs. It is our server's key to read Lucira's data
  (not customer login).
- **Data source = `POS > Invoice`** (store bills). `POST /Services/POS/Invoice/List`
  - Request: `Skip`, `Take`, `Sort`, `Criteria`, `EqualityFilter` (Serenity-style ListRequest).
    Date filtering via `Criteria` is **not documented — must be tested** on the test server.
  - Response: `{ Entities: [POS.InvoiceRow], TotalCount, Skip, Take, Error }`
  - `POS.InvoiceRow` fields we map:

    | Ours | OrnaVerse |
    |---|---|
    | sale_id | `transaction_id` (int64); bill no = `document_no` |
    | event_time | `document_date` (timezone unknown — probably IST, confirm) |
    | amount | `net_amount` |
    | phone | `phone_code` + `mobile` (separate fields) |
    | email | `email` |
    | name | `party_name` (full name, not split) |
    | city/state/zip | `shipping_city`, `shipping_state`, `shipping_pin_code` |
    | store | `mailing_name` / `company_name` |
    | status | `document_status` (int — **codes unknown**) |
    | — | `party_id` (customer), `modification_date`, `currency_id` (int) |
- `POS > Customer` (by `party_id`): `birth_date`, `gender` (int), `pin_code` — optional enrichment.
- `POS > Invoice > GetPOSSales`: invoices **+ returns** in one feed (`RCPT_NUM`, `INV_AMT`,
  `RET_AMT`, `TRN_STATUS`, `CUST_*`) — mall-reporting format; maybe useful for returns later.
- Not useful: `Reports > CustomerHistory` (one customer's history), sales reports/totals,
  `Sales > *` (likely wholesale/B2B).
- **Webhooks exist**: `Administration > WebhookSubscriptions` (Create, SamplePayload,
  ListIntegrationEntityTypes) and `Administration > DocumentsWebhooks`. OrnaVerse can
  **push** each posted invoice to our `/webhook/ornaverse`.

## Proposed design (agreed direction, not built yet)

- **Webhook = main path**: OrnaVerse pushes posted POS invoices → `/webhook/ornaverse` →
  verify signature → map → existing matcher (`ingestSale`) → send.
- **Hourly pull = backup** (already wired in `src/lib/sync.ts`; only
  `fetchOrnaverseSales()` in `src/importers/ornaverse.ts` is empty): token → `POS/Invoice/List`
  for the window since last run, paged → keep posted & not-cancelled → map → matcher.
- Duplicates are blocked by sale id, so both paths can run.
- Returns/exchanges: separate small step after this works.

## Next actions

1. Export these pages into `api-dog-pages/` (open each link in a browser that has the docs
   password entered → Ctrl+A, Ctrl+C → paste):
   - WebhookSubscriptions SamplePayload ⭐ https://ornaverse-advantage.apidog.io/samplepayload-45759418e0.md
   - WebhookSubscriptions Create https://ornaverse-advantage.apidog.io/create-41876544e0.md
   - WebhookSubscriptions ListIntegrationEntityTypes https://ornaverse-advantage.apidog.io/listintegrationentitytypes-41876549e0.md
   - Schema WebhookSubscriptionsRow https://ornaverse-advantage.apidog.io/administration-webhooksubscriptionsrow-17081944d0.md
   - DocumentsWebhooks Create https://ornaverse-advantage.apidog.io/create-41876316e0.md
2. Ask OrnaVerse / Lucira:
   - API client **client ID + secret** for `test.ornaverse.in`, and the exact `/connect/token` request
   - `document_status` codes (draft / posted / cancelled)
   - Can they set up a webhook to our URL for POS invoices (or do we create it via API)?
   - Timezone of `document_date`; `currency_id` for INR
3. Then build step 5 (webhook + pull), test with sample payloads, show before committing.

## Open decisions

- Returns / cancellations after we already sent a sale: skip only, or also correct?
- Exchange bills (old gold): send net amount or full bill value?

## Env (see `.env.example`)

OrnaVerse will need (replacing `ORNAVERSE_API_KEY`):
```
ORNAVERSE_API_BASE=https://test.ornaverse.in
ORNAVERSE_CLIENT_ID=
ORNAVERSE_CLIENT_SECRET=
```
Plus a webhook secret once we see how OrnaVerse signs requests.
Meta: `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `META_TEST_EVENT_CODE`.
Google: `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_CONVERSION_ACTION_OFFLINE`, service account
added as a user in Google Ads; `GOOGLE_VALIDATE_ONLY=true` until tested.

## Small known issues (not blockers)

- `src/routes/webhook-ornaverse.ts` stub logs the full request body → raw phone/email in
  logs. Fix when building step 5.
- One person can have two visitor docs (keyed phone → email → user_id); the matcher takes
  the first found, so click ids on the other doc are missed.
- Store-bill email matching uses the Meta-format hash; matching on `email_google_hash`
  would also catch gmail dot variants.
- IP / user agent from the website visit are still sent to Meta for store sales.

## How the user wants to work

- Discuss and explain simply first; **no code changes until the user says go**.
- Small steps; show what was built + how it was verified; commit only when asked; push when asked.
- Research-based decisions (check Meta/Google official docs), check edge cases.
