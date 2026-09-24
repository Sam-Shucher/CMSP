# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Mini Library — an invite-only web app for a tabletop miniatures collection,
split into isolated "collections" (groups, e.g. "Chicago", "dojo"). Runs
full-time on a Raspberry Pi. See `README.md` for the full picture (stack,
local dev setup, collections model, Pi deployment).

- `backend/` — Express + TypeScript + MySQL/MariaDB (`mysql2`), JWT cookie auth
- `frontend/` — React + Vite + TypeScript
- `tests/` — Playwright end-to-end tests (the whole app in a real browser)
- `scripts/` — Raspberry Pi setup/update scripts

## House style

- **Queries** go through `backend/src/db/query.ts` (`rows`, `firstRow`,
  `firstValue`, `change`, `insert`) with a row interface per query — not
  `pool.execute` with a cast. Placeholders only, never string-built SQL.
- **Route handlers** are wrapped in `route()` (`backend/src/utils/route.ts`),
  which logs anything unexpected and replies with a generic 500.
- **Limits** live in one place per side: `backend/src/utils/inputs.ts` +
  `config.ts`, and `frontend/src/limits.ts` (which mirrors them).
- **Frontend tests** share `src/test/apiMock.ts` (`jsonResponse`, `urlOf`,
  `jsonBodyOf`) instead of each file rolling its own fetch stub.
- **Days and times of day** a person picks (bookings, back-by dates, handoff
  hours) are the group's, via `backend/src/utils/appTime.ts` (`APP_TIMEZONE`,
  Chicago by default) — never `CURDATE()`, `toISOString().slice(0, 10)` or
  UTC hours. Pass "today" into SQL as a value. Times this process writes (a
  due date) are compared with this process's clock, not the database's `NOW()`.
- **Transactions** use `inTransaction` from `db/query.ts`; a rule checked by
  "read, then write" in two steps gets a locked re-read inside one, and a test
  in `concurrency.integration.test.ts`.

## Commands

```bash
npm run dev                                 # both servers (root)
npm --prefix backend run test               # backend unit tests — mocked DB
npm --prefix backend run test:integration   # backend tests against real MariaDB (needs docker compose -f docker-compose.test.yml up -d)
npm --prefix frontend run test              # frontend tests
npm run test:e2e                            # Playwright end-to-end in tests/ (builds first; needs the same Docker MariaDB)
npm run lint                                # ESLint (type-aware) over backend, frontend, and tests

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
  holds no role — it comes from the database on every request: `requireAuth`'s
  session query (`touchSession`) also reads the membership of the cookie's group,
  and `requireCollectionMembership` uses that, querying itself only if it wasn't read.
  Things in another collection return **404**, not 403. The frontend sends the group
  a page is showing as `X-Collection-Id`; a mismatch with the session (switched in
  another tab) is refused with 409 `group_changed` so nothing lands in the wrong group.
- **Removing a member** goes through `services/membership.ts`: refused while a mini is
  out on loan with/from them; otherwise their requests are cancelled (with notices),
  holds/cart cleared, and their minis in that group removed. If the account is
  deleted, its loans stay (`borrower_id`/`owner_id` go NULL, the name is saved in
  `removed_borrower_name`/`removed_owner_name`), so a query joining a loan to
  `users` for a name needs a `LEFT JOIN` + `COALESCE` if it covers past loans.
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
- **Uploads:** saved names come from the file's actual bytes (`utils/imageType.ts`),
  never the uploader's filename or claimed type — a text file renamed .png is refused. Photos are served only to members of the mini's collection
  (`requireImageAccess`). Client-supplied image paths must be checked against
  what the mini already has. Any error response deletes that request's uploaded
  files; `maintenance/housekeeping.ts` sweeps unreferenced files hourly — if you
  add a new place that stores upload paths, add it to the sweep's in-use query.
- **Phone notifications (Web Push):** every `notify()` also pushes, via
  `services/push.ts`, which never throws — don't send pushes from anywhere else.
  Subscription endpoints are accepted only on the browser push services
  (`utils/pushSubscription.ts`), since the server makes requests to them.
- **Secrets:** `JWT_SECRET` comes from `config.ts` (no fallback). Nothing secret
  goes in git; `backend/.env` is ignored.
- **Passwords:** only `utils/passwords.ts` hashes or checks them (bcrypt, cost
  from `PASSWORD_COST`, salted per password). Weaker old hashes are upgraded
  after a successful sign-in. A locked-out member gets a temporary password from
  an admin (`POST /api/admin/users/:id/reset-password`) — only from an admin of
  *every* group that member is in, since the password is the whole account's.
  Until they change it, `requireAuth` refuses everything with 403
  `password_change_required`; the few routes that screen needs use
  `requireAuthAllowingTemporaryPassword` (listed in `accessControl.test.ts`'s
  `TEMPORARY_PASSWORD_OK`). See BACKLOG.md for the planned move to scrypt.
- `backend/src/accessControl.test.ts` reads every route from the live app and
  checks it rejects anonymous, forged, non-member, and non-admin callers. A new
  public route must be added to its `PUBLIC` list deliberately.

## Testing approach

This project is built test-driven: write the test (mocked unit test for
route logic; real-database integration test for anything SQL-shaped)
before writing the implementation.

**Claude does not run the test suites, `npm run test:e2e`, or
`tsc --noEmit` after finishing a feature or fix.** The user runs those
themselves and reports back the results or anything that needs changing.
Claude should still write/update tests as part of test-driven development,
and may run a single targeted test file while actively debugging a specific
failure the user has already reported — just not the full suites as a
"did I finish" check.
