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

## Testing approach

This project is built test-driven: write the test (mocked unit test for
route logic; real-database integration test for anything SQL-shaped)
before writing the implementation. Both suites must pass, along with
`tsc --noEmit` in both `backend/` and `frontend/`, before considering a
change done.
