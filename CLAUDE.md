# lucira-capi

Offline conversion sync: OrnaVerse store sales → matched to website visitors → Meta CAPI + Google Data Manager API.

- Current status, OrnaVerse findings and next steps: see `docs/HANDOFF.md` — read it first.
- Discuss and explain simply before changing code; make changes only after the user says go. Small steps, commit/push only when asked.
- `npm test` (node:test via tsx), `npm run typecheck`.
- `api-dog.txt` and `api-dog-pages/` (in `ornaverse-api-docs/`) are private OrnaVerse docs — gitignored, never commit them.
- OrnaVerse = PRODUCTION only, no test server. **Read-only actions only** (token, `List`, `Retrieve`) — never Create/Update/Delete/Post/Cancel or webhook-subscription writes. Small `Take`, ask the user before every live call, mask customer PII in output.
- Deploy only via `deploy/deploy.mjs` (one script for Windows, Linux, macOS — don't add OS-specific copies).
- Secrets live only in `.env` (gitignored). Never open or print `.env`, never put real values in `.env.example`. OrnaVerse credentials cannot be rotated.
