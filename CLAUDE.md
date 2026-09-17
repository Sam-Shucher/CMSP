# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Mini Library — an invite-only web app for a tabletop miniatures collection,
split into isolated "collections" (groups, e.g. "Chicago", "dojo"). Runs
full-time on a Raspberry Pi. See `README.md` for the full picture (stack,
local dev setup, collections model, Pi deployment).

- `backend/` — Express + TypeScript + MySQL/MariaDB (`mysql2`), JWT cookie auth
- `frontend/` — React + Vite + TypeScript
- `scripts/` — Raspberry Pi setup/update scripts

## Commands

```bash
npm run dev                                 # both servers (root)
npm --prefix backend run test               # backend unit tests — mocked DB
npm --prefix backend run test:integration   # backend tests against real MariaDB (needs docker compose -f docker-compose.test.yml up -d)
npm --prefix frontend run test              # frontend tests
npm run test:e2e                            # Playwright end-to-end (builds first; needs the same Docker MariaDB)
npm --prefix backend run build              # tsc + copies db/migrations/*.sql into dist/
```

## Database schema changes — read this before editing schema.sql

`schema.sql` only runs `CREATE TABLE IF NOT EXISTS`. It builds a fresh
database correctly, but does **nothing** for a database that already
exists — a new column on an existing table is silently skipped. This has
caused multiple production outages (features shipping in code that the
Pi's actual database never received).

**The rule: any change to `schema.sql` that isn't a brand-new `CREATE TABLE`
must be paired with a new file in `backend/src/db/migrations/`**, numbered
sequentially (`004_...sql` after the last one). Migration files must be
idempotent (`ADD COLUMN IF NOT EXISTS`, guard-check before adding a
constraint) — they may run any number of times, including against a
database that already has everything via a fresh `schema.sql`.

After adding a migration, run `npm --prefix backend run test:integration` —
`migrations.integration.test.ts` builds one database from `schema.sql` and
another from `schema.baseline.sql` + every migration file, then asserts
they're identical. If they're not, a migration is missing or wrong; fix
the migration, never the test.

Migrations apply automatically on every deploy via `scripts/rpi-update.sh`
(and on first-time setup via `scripts/rpi-setup.sh`) — there's no manual
SQL step for the person deploying this.

## Security rules — follow these for every new route or field

- **SQL:** placeholders (`?`) only. Never build SQL from request values.
- **Access:** collection-scoped routers use `requireAuth, requireCollectionMembership`
  (admin routes add `requireAdmin` *after* it). Roles are **per collection**
  (`collection_memberships.role`); `users.role` is legacy and unused. The cookie
  holds no role — `requireCollectionMembership` loads it from the database.
  Things in another collection return **404**, not 403.
- **Sessions:** `requireAuth` checks the signed cookie *and* its row in `sessions`
  (`db/sessions.ts`). Unit tests replace that module with an always-live stand-in
  (`src/test/unitSetup.ts`); integration tests use real session rows via
  `test/dbHelpers.ts`.
- **Holds & notifications:** hold-line changes go through `services/holds.ts`
  (transactions that lock the mini row); loan notifications through
  `services/loanEvents.ts`. Anything that makes a mini free again must call
  `promoteNextHold(miniId)`. Unit tests stub these modules (`unitSetup.ts`); their
  real behavior is tested in `holds.integration.test.ts` / `notifications.integration.test.ts`.
- **Input:** validate every body/query value with `backend/src/utils/inputs.ts`
  (type + length) before it reaches the database. Query strings can be arrays or
  objects; JSON can be any type.
- **Uploads:** saved names come from the checked image type, never the uploader's
  filename. Photos are served only to members of the mini's collection
  (`requireImageAccess`). Client-supplied image paths must be checked against
  what the mini already has. Any error response deletes that request's uploaded
  files; `maintenance/housekeeping.ts` sweeps unreferenced files hourly — if you
  add a new place that stores upload paths, add it to the sweep's in-use query.
- **Secrets:** `JWT_SECRET` comes from `config.ts` (no fallback). Nothing secret
  goes in git; `backend/.env` is ignored.
- `backend/src/accessControl.test.ts` reads every route from the live app and
  checks it rejects anonymous, forged, non-member, and non-admin callers. A new
  public route must be added to its `PUBLIC` list deliberately.

## Testing approach

This project is built test-driven: write the test (mocked unit test for
route logic; real-database integration test for anything SQL-shaped)
before writing the implementation. Both suites must pass, along with
`tsc --noEmit` in both `backend/` and `frontend/`, before considering a
change done.
