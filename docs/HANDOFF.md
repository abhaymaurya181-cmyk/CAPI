# Handoff — Lucira offline CAPI (as of 2026-10-27)

Read this first when continuing on a new machine / new Claude session.

## ⚠️ Hard rules (read before touching OrnaVerse)

1. **OrnaVerse is PRODUCTION only** (`https://lucira.live.ornaverse.in`). There is **no test server**
   for us (`test.ornaverse.in` in their docs is not ours). Treat every call as touching live business data.
2. **Read-only, strictly.** Every OrnaVerse endpoint is HTTP `POST`, even reads — so the rule is about the
   *action*, not the HTTP method:
   - ✅ Allowed: `POST /connect/token` (auth), `POST /Services/POS/Invoice/List`,
     `POST /Services/POS/Invoice/Retrieve`, `POST /Services/POS/Customer/List|Retrieve`,
     `WebhookSubscriptions/ListIntegrationEntityTypes` and `WebhookSubscriptions/SamplePayload` (both only
     return information).
   - ❌ Never: any `Create`, `Update`, `Delete`, `Post`, `Cancel`, `ApplyAdditionalDiscount`,
     `PostToShopify`, `UpdateInsurance`, `GeneratePDF`, anything under `Administration` that writes —
     **including `WebhookSubscriptions/Create`**. If a webhook is needed, the OrnaVerse team creates it.
   - Keep reads small (`Take` 1–10 for checks) and **ask the user before every live call**.
3. **Secrets:** OrnaVerse client id/secret belong to Lucira and **cannot be rotated** by us.
   - They live only in `.env` (gitignored). Never in `.env.example`, never in code, never in chat/logs.
   - **Do not open/print `.env`** (the user asked for this). Scripts may load it via `dotenv` without
     printing values. If you must check a value exists, print `set` / `MISSING` only.
   - On a new laptop, the user creates `.env` by hand (`cp .env.example .env`, then fill values).
4. **Customer data (PII):** when printing OrnaVerse rows, show only non-PII fields
   (`transaction_id`, dates, `document_status`, store) — mask names, phones, emails, addresses.
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
| 3 Meta sender (`physical_store`, 62-day limit, test-event script) | ✅ done — not tested live (no Meta creds) |
| 4 Google sender on Data Manager API (`validateOnly`) | ✅ done — not tested live (no Google creds) |
| 5a OrnaVerse hourly pull | ✅ works against live tenant; posted-only default; 15s timeouts; 3-day look-back (new bills only); ₹0 bills skipped |
| 5a+ Daily safety re-scan (last 30 days, new bills only) | ✅ done 2026-10-25 |
| 5b OrnaVerse webhook | ⏸ parked — not needed for go-live; `retrieveOrnaverseSale(id)` built + verified live; route is a stub (no PII logged) |
| 6 Matcher, sync log, hourly sync, retry back-off | ✅ done; now combines a person's visitor docs + gmail variants |
| 6+ Stuck-sale recovery (`requeueStuck`, daily + admin "Resend stuck") | ✅ done 2026-10-25 |
| 7 Admin: sync log, match details, resend, payload preview, IP geo | ✅ done |
| 7+ Admin **Analytics** tab (`/admin/api/analytics`, `src/lib/analytics.ts`) | ✅ done 2026-11-11 |
| 8 CSV upload route | ✅ route done; upload **page** deferred by user |
| Deploy tooling (`deploy/deploy.mjs`, one script for Windows/Linux/macOS) | ✅ done; Linux path not yet run; no real deploy yet |
| Live Meta / Google tests | ❌ waiting for credentials (see Env) |
| Deploy (Cloud Run, scheduler, indexes, domain, GTM) | ❌ waiting for a Google Cloud project |

`npm test` → 106 passing. `npm run typecheck` clean.

## What was built on 2026-10-25 (this laptop)

- **Importer safety:** `ORNAVERSE_POSTED_STATUSES` unset/invalid → posted only (1), never returns; rows
  without a status dropped; 15s timeout on every OrnaVerse call.
- **`retrieveOrnaverseSale(id)`** (`POS/Invoice/Retrieve`, body `{ EntityId }` — Serenity convention,
  **not yet verified live**): posted-only, id-mismatch guard, one retry on 401, strict id parsing.
- **Daily re-scan** `POST /internal/sync-offline-rescan` (scheduler 03:30, off the hour): re-reads posted
  bills dated in the last `ORNAVERSE_RESCAN_DAYS` (default 30, max 60) and imports only sales never
  recorded. Shares the hourly lock, never moves the hourly cursor, `page_limit_reached` if capped.
- **Matching:** `findVisitorCandidates` (phone, email, Google-format email → catches gmail dot/+tag
  variants) + `combineCandidates` (best eligible click per platform across all of a person's docs;
  admin shows "Clicks also from").
- **Stuck sales:** missing Meta/Google credentials no longer burn the 6 attempts. `requeueStuck` requeues
  (only when a send can work now): legacy rows without `next_retry_at`, `*_not_configured` failures once
  configured, Google `validated` rows once `GOOGLE_VALIDATE_ONLY=false`, retryable failures with attempts
  left. Runs daily after the re-scan and from the admin "Resend stuck" button (`?dry_run=1` counts only).
  Transaction re-check so a just-sent sale is never reset.
- **Webhook stub** logs size / content type / field names only — never values.
- **Deploy:** `deploy/deploy.mjs` replaces the bash scripts (see Deploy below). `.gcloudignore` keeps
  `.env`, keys and private docs out of uploads. `.gitattributes` keeps `.sh`/`.mjs` LF.

## OrnaVerse — verified facts (live tenant)

- Base: `https://lucira.live.ornaverse.in` (strip trailing slash — `//connect/token` → 404).
- Auth: `POST /connect/token`, form-encoded, `grant_type=client_credentials`, `client_id`, `client_secret`,
  **`scope=openid`** (OpenIddict; without scope → `400 invalid_scope`).
- Data: `POST /Services/POS/Invoice/List` with Bearer token. Body = Serenity ListRequest
  (`Skip`, `Take`, `EqualityFilter`, …). Response `{ Entities, TotalCount, Skip, Take, Error }`.
- Quirks: **any `Sort` → HTTP 500** (default order newest `transaction_id` first); **unknown field in
  `EqualityFilter` → HTTP 500**.
- `document_status`: **1 = posted (~97%)**, **2 = returns/cancels (~3%)** — exact meaning of 2 unconfirmed.
- `transaction_id` is an int64 (docs) — not a UUID.
- Field mapping (`mapInvoiceRow`): sale_id = `transaction_id`; event_time = `document_date` (IST if no
  offset); amount = `net_amount`; phone = `phone_code` + `mobile`; `email`; name = `party_name` (split);
  `shipping_city/state/pin_code`; store = `mailing_name` || `company_name`; currency INR.
- InvoiceRow also has `creation_date`, `modification_date`, `allow_backdated_entry`,
  `number_of_backdated_days` (backdated bills are possible).
- **Read-only check 2026-10-27** (30 latest bills, ids 2156–2185, TotalCount 2037; 5 bills via Retrieve):
  - Dates are full **UTC timestamps with `Z`** (e.g. `2026-10-27T09:09:32.425Z`) — real time of day, parsed as-is.
  - `creation_date` ≈ `document_date` (seconds apart); newer id ⇒ newer creation; none backdated in the 30.
  - `modification_date` is empty in List.
  - `Retrieve` with `{ EntityId }` **works** (verified). List does not return `line_items`; Retrieve does.
  - Phone: `phone_code` + 10-digit `mobile`, never already starting with 91 → `joinPhone` is fine. One bill had
    `phone_code=1` (maybe a staff mistake — would not match an Indian number); one had no code (→ +91 default).
  - Amounts: `net_amount` = full bill. Return credit / advances appear as payment modes in `receipt_details`
    (e.g. UPI + "Return", "Order Advance"), not as deductions. No `is_exchange` items seen yet.
  - 2 of 30 bills had `net_amount = 0` (100% discount) → now skipped (not purchases).
  - One bill was posted but unpaid (`receipt_amount 0`, `balance_amount` = net) — still sent as a sale.
- **Lucira answers (2026-10-27):** backdated bills — rarely, max 2–3 days; draft posted later — yes, can
  happen; return — a **new** return bill is created (original unchanged → no correction needed);
  exchange — send the **full bill** (= `net_amount`).
- **Webhooks (from exported docs):** `WebhookSubscriptions` rows have `entity_type`, `operation` (int 1–5,
  "lifecycle operation" — meanings undocumented), `url`, **`secret_key`**, `active`, `failure_count`, and a
  deliveries log with `attempt_count` (OrnaVerse retries; schedule unknown). `SamplePayload` returns the
  exact payload for an entity_type + operation. `DocumentsWebhooks` is an older type with no secret — don't use.

Private OrnaVerse docs: `ornaverse-api-docs/` (`api-dog.txt` index + `api-dog-pages/`, incl. the 7 webhook
pages), **gitignored** — copy the folder to a new laptop by hand. Online:
https://ornaverse-advantage.apidog.io (password — ask the team; not stored in repo).

Scripts (read-only, load `.env` via dotenv; **ask the user before running any — production**):
- `node scripts/orna-smoke.mjs` — token + several `Invoice/List` probes (ids/dates/status/store only).
- `npx tsx scripts/orna-importer-live.mjs` — real `fetchOrnaverseSales()` for the last 24h.
- `npx tsx scripts/orna-readonly-check.ts` — **prepared, not run yet**: latest 10 bills' `transaction_id` /
  `document_date` / `creation_date` / `modification_date` / status (id order + backdated check), one
  `Retrieve` (verifies `{ EntityId }`), `ListIntegrationEntityTypes`, `SamplePayload` field names for ops 1–5.

## Open issues / decisions

1. ✅ **Backdated / late-posted bills (2026-10-27):** every hourly pull now also re-reads bills dated in
   the last `ORNAVERSE_HOURLY_LOOKBACK_DAYS` (default 3) and imports **only bills never recorded**
   (`importSales(..., { onlyNew: true })` — re-ingesting would reset retries and re-send). Daily re-scan
   (30 days) stays as the safety net. Side effect: a bill edited after we first imported it is not
   re-imported (edits of posted bills are not expected).
2. ✅ Time-of-day, status 2, phone format, exchange amount — settled (see read-only check + Lucira answers).
   ₹0 bills skipped in `mapInvoiceRow`.
3. **Webhook (5b): parked.** Not needed to go live (hourly pull + 3-day look-back + daily re-scan cover
   everything; ads platforms accept days-old store sales). OrnaVerse's webhook questions were never sent.
   If wanted later: their team must create the subscription (read-only rule). Design: verify `secret_key`
   → bill id → `retrieveOrnaverseSale` → `ingestSale` → dispatch. Cheaper alternative: run the hourly
   sync every 15 min (`SYNC_SCHEDULE`). The 7 webhook doc pages exist only on the other laptop.
4. **Meta parked by the user (2026-10-27) — Google first.** Unconfigured Meta does not burn retries;
   `requeueStuck` sends them once Meta creds are added.
5. Google `eventSource`: we send `IN_STORE`; one-line change if Google rejects it.
6. Exchange bills with `is_exchange` items not seen yet — check one when it appears.

### Questions sent / to send

- **Lucira staff:** backdated bills (allowed? how many days?); draft then posted later?; return = new bill
  or original changes?; exchange → which amount?; can OrnaVerse set up a webhook (and how is it secured)?
- **OrnaVerse:** webhook `operation` codes 1–5 (which is "POS invoice posted")?; how `secret_key` is used
  (header, signature method)?; retry schedule; can their team create the subscription?

## Env (`.env`, gitignored — filled by hand on each machine)

OrnaVerse (✅ set on this laptop):
```
ORNAVERSE_API_BASE=https://lucira.live.ornaverse.in
ORNAVERSE_CLIENT_ID=<from Lucira>
ORNAVERSE_CLIENT_SECRET=<from Lucira>
ORNAVERSE_SCOPE=openid
ORNAVERSE_POSTED_STATUSES=1
ORNAVERSE_RESCAN_DAYS=30
ORNAVERSE_HOURLY_LOOKBACK_DAYS=3
```
Meta (❌ waiting): `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `META_TEST_EVENT_CODE`
→ `npm run meta:test -- [phone] [email]`.

Google (user has `GOOGLE_ADS_CUSTOMER_ID` + `GOOGLE_ADS_LOGIN_CUSTOMER_ID`; still needed:
`GOOGLE_ADS_CONVERSION_ACTION_OFFLINE` — the `ctId=` number of the "Store Purchase" action (type Import →
clicks) — and `GOOGLE_CLOUD_PROJECT`). Auth: a service account in our GCP project, added as a user in
Google Ads; locally either `GOOGLE_APPLICATION_CREDENTIALS=<key file outside repo>` or (preferred, no key)
`gcloud auth application-default login --impersonate-service-account=<email>`.
`GOOGLE_VALIDATE_ONLY=true` until tested → `npm run google:validate -- [phone] [email] [gclid]`.
`GOOGLE_ADS_LOGIN_CUSTOMER_ID` empty if there is no manager account (or it equals the customer id).

## Deploy

One script for every OS — `deploy/deploy.mjs` (details in `deploy/README.md`):
```
node deploy/deploy.mjs secret <NAME> --project <id>    # store a secret (hidden input via stdin)
node deploy/deploy.mjs grant --project <id>            # Cloud Run SA → secrets + Firestore
node deploy/deploy.mjs service --project <id> --dry-run
node deploy/deploy.mjs all --project <id>              # service + 3 scheduler jobs
```
Only `ADMIN_TOKEN` + `INTERNAL_TOKEN` are required; each integration switches on when its secrets exist
(staged go-live). Verified on Windows end-to-end against a fake gcloud; the Linux/macOS path has not been
run yet — have a teammate run `--dry-run` once. Blocked on: which Google Cloud project to use.

## Upgrade round (2026-11-11) — user's 3 tasks

1. **Online (Shopify) orders in the dashboard — SHOW ONLY, never send to Google/Meta** (Lucira's website
   already reports online purchases with its own Purchase event; sending would double count).
   Plan: hourly read-only pull of paid orders (Shopify Admin API, `read_orders` only, with protected
   customer data access for email/phone/name) → match to visitors → store with `action_source: "website"`
   → appears under the Online filter. ❌ Waiting for `SHOPIFY_STORE_DOMAIN` + `SHOPIFY_ADMIN_TOKEN` in `.env`.
2. ✅ **Analytics tab** — OMS-style: filters (date range by sale date in IST, online/offline, store), KPI
   cards (orders, value, matched, with ad click, sent to Google, needs attention), chips (channel, matched
   by, ad click, Google status; Meta row once Meta is used), by-store and by-day tables. Built only from
   data we already store (no category, no city — user's choice). Verified on the Firestore emulator.
3. **Google: send store sales to Lucira's own existing Purchase conversion action**; set "offline (web)"
   to Secondary in Google Ads (user/teammate). First run `npm run google:validate` against the Purchase
   action id (validateOnly) — website-tag-only actions may reject server-sent sales; if so, create a
   Purchase action of type Import and use that. Likely only `GOOGLE_ADS_CONVERSION_ACTION_OFFLINE` changes.
   ❌ Waiting for the Purchase action id (`ctId=`).

## Next actions (in order)

1. ✅ Read-only check run 2026-10-27; ✅ 3-day hourly look-back + ₹0 skip built (101 tests).
2. ✅ **Google validateOnly passed (2026-10-27):** HTTP 200, `validated: true` with a fake customer —
   service account `lucira-capi-sender@lucirajewelry-prod.iam.gserviceaccount.com` has Google Ads access,
   conversion action id correct, `IN_STORE` accepted, no login (manager) customer id needed. GCP project
   = `lucirajewelry-prod` (to be confirmed by the user for deploy). Key file must live **outside** the repo
   (`.gitignore`/`.gcloudignore` now also block `*-key*.json` and `*.zip`); Cloud Run needs no key file.
   Next: deploy dry-run → deploy → one OrnaVerse bill end to end.
3. Meta later (creds → `npm run meta:test`). Webhook parked (see Open issues 3).
5. Google Cloud project decided → deploy (`node deploy/deploy.mjs …`), Firestore indexes, service account
   in Google Ads, `track.lucirajewelry.com`, tracker on site via GTM.
6. Set `GOOGLE_VALIDATE_ONLY=false` → redeploy; stuck "validated" sales are requeued automatically (daily)
   or via "Resend stuck".
7. Later: returns/corrections, CSV upload page.

## Git / GitHub access (Windows laptop notes)

- Repo `abhaymaurya181-cmyk/CAPI` (private). On one laptop the `Maroof-56` account had **no access**
  ("Repository not found") — use the `abhaymaurya181-cmyk` account: `gh auth switch -u abhaymaurya181-cmyk`.
  On this laptop plain `git pull` / `git push` worked on 2026-10-25.
- If git still uses cached Maroof-56 credentials:
  `git -c credential.helper= -c credential.helper='!gh auth git-credential' pull`
- Don't use another account's token without the user saying so.

## How the user wants to work

- Discuss and explain simply first; **no code changes until the user says go**.
- Small steps; show what was built + how it was verified; commit only when asked; push when asked.
- Research-based decisions (check Meta/Google official docs), check edge cases.
- OrnaVerse: read-only, small, ask before each live call (see Hard rules).
- Deploy: keep **one** cross-platform script (`deploy/deploy.mjs`); no OS-specific copies.
