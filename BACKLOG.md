# Backlog

Things deliberately deferred, with enough context to pick them up cold.

## Feature ideas

Numbered so they can be referred to by number in conversation. The numbers are
stable names, not an order of priority — 1 and 2 are simply the two picked up
first. Status is marked where work has started.

**Smaller, self-contained:**

1. **Renew / extend a loan** — *done*. A borrower (or the owner) keeps a mini
   longer without cancelling and re-requesting. Blocked while anyone is in the
   hold line, the way a library refuses a renewal on a reserved book. Bounded by
   the same three months as any loan, counted from the handoff.
2. **Sort and filter the browse page** — not started. Only one tag plus a
   search today. Available-only, by owner, newest, name, price.
3. **A mini's history** — *done*. Who has had it and how often. Owner (or
   admin) only, on the edit page, collapsed until asked — this app otherwise
   keeps a mini's CURRENT borrower anonymous to bystanders, so a full
   name-and-date history of PAST borrowers is scoped the same way editing is,
   not shown to everyone.
4. **Sets / armies** — *done*. Group your own minis into a named set (a boxed
   army, a Kill Team) on the new Sets page; anyone else can borrow the whole
   thing in one action (`POST /api/sets/:id/cart`), which just adds every
   available member to their cart — checkout then does exactly what it
   already does, one request per mini, no new loan concept needed. Deleting a
   set ungroups its minis rather than deleting them (`ON DELETE SET NULL`).
   An admin can rename, delete, or remove members from anyone's set, but
   "add a mini" is owner-only in the UI — the admin's own ungrouped minis
   aren't the right list to offer there, and the backend already refuses an
   admin sneaking their own mini into someone else's set if that were tried
   directly.
5. **Transfer ownership** — someone sells or gives a mini to another member.
   Today the only path is delete and re-add, which throws away its history.
6. **Lost / damaged as a loan outcome** — statuses are negotiating, adventuring,
   returned, cancelled. Real life also includes "it broke" and "it never came
   back", and there's nowhere to record either.
7. **Admin audit log** — removing a member deletes their minis. That much power
   should leave a trace of who did it and when.
8. **Grace period on member removal** — archive, then purge later, instead of an
   immediate cascade. Same reasoning as the audit log.
9. **Export my collection** — a member takes their own data out; doubles as a
   second backup path.
10. **QR labels** — print a sheet, one per case, scan to open that mini. Very
    library, and genuinely good at a handoff.
11. **Wishlist** — "looking for a Beholder", and owners see the matches.

**Larger, would change how the app is used:**

12. **Condition record at handoff and return** — a note and a photo at each end
    of a loan, so "the spear was already bent" is a fact instead of an argument.
    The most valuable of these for lending fragile painted things, and it fits
    the loan lifecycle that already exists (`handed_off_at`, `received_at`,
    `returned_at`).
13. **Booking for a date** — holds answer "tell me when it's free"; they don't
    answer "I need these four for game night on the 14th", which is how tabletop
    actually works. Needs real design: overlapping bookings, no-shows, and how
    it interacts with the hold line.
14. **Web Push and a PWA install** — notifications only exist if someone opens
    the site, and there is no email by design. Web Push works on Android Chrome
    and on iOS 16.4+ for installed PWAs, and the tunnel already gives HTTPS. A
    manifest and icons also make "Add to Home Screen" produce a real app.
15. **Bulk add** — adding a real shelf one mini at a time, three photos each, is
    what will stop someone finishing. CSV import, or dropping twenty photos and
    naming them as you go. Unglamorous; the biggest adoption win here.
16. **A message thread per loan** — negotiation is structured fields, with no
    room for "running 20 minutes late". So people drop to texting and the app
    loses the record of what was agreed.

**Decided against, with reasons:**

- **Public reliability scores.** "Bruno returns things late 3 times in 10" is
  useful and socially poisonous in a friend group. If ever wanted: show counts
  privately to the owner, never a ranking.
- **Payments or deposits.** `price` as "what it's worth" is fine. Money moving
  between friends brings disputes and refunds, and makes this a different app.
- **Minis visible in more than one collection.** Isolation is the invariant the
  whole app is built on — every query, test and clean-up path assumes one mini
  in one collection. A small convenience isn't worth undoing the guarantee.
- **Anything public or SEO-facing.** Invite-only is a feature.

## Move password hashing to scrypt (or argon2id)

**Why.** We hash with `bcryptjs` — a pure-JavaScript bcrypt, used because the
native `bcrypt` package wouldn't build on the Pi. Pure JS is roughly 4–8×
slower than the native C version on the same chip, so we pay a large cost per
sign-in for work an attacker does at full native (or GPU) speed against a
stolen database. bcrypt is also not memory-hard, which is what actually blunts
GPU cracking.

**Measured** (i9-12900K, 2026-09):

| Algorithm | Time |
|---|---|
| bcryptjs cost 10 | 55 ms |
| bcryptjs cost 11 | 100 ms |
| bcryptjs cost 12 | 206 ms |
| bcryptjs cost 13 | 402 ms |
| scrypt N=16384 (16 MB) | 23 ms |
| scrypt N=32768 (32 MB) | 49 ms |
| scrypt N=65536 (64 MB) | 94 ms |

The production Pi is a Cortex-A72 (Pi 4) at up to 1.8 GHz, currently clocked
around 33%, with memory pressure (~3.2 GB of 3.7 GB used, swap full). Run
`npm --prefix backend run bench:hash` **on the Pi** for real numbers before
choosing parameters — and mind the memory: scrypt at 64 MB per hash is a lot
on that box today. 32 MB is the safer starting point there.

**How.** `crypto.scrypt` is built into Node (native, no install step, doesn't
block the event loop). The upgrade path already exists: `utils/passwords.ts`
owns hashing, and `needsRehash()` plus the post-login upgrade in
`routes/auth.ts` re-hash each password as people sign in. Extend
`verifyPassword` to recognise both formats (bcrypt hashes start `$2`), hash new
ones with scrypt, and have `needsRehash` return true for any bcrypt hash.
Nobody gets locked out, and no reset is needed.

**Note.** If this app ever moves off the Pi (K8s/AWS was mentioned), revisit
argon2id at the same time — the native build objection goes away in a container.

## Pepper the password hashes

A secret key from `backend/.env`, HMAC'd into the password before hashing, so a
stolen database dump is useless without the app's secret as well. Worth most if
database backups are stored somewhere the `.env` file isn't. Costs: another
secret that must be backed up separately and never lost — losing it makes every
password unusable — and a rotation story (hash-of-hash, or re-pepper on login).
Do it with the scrypt move, not separately.

## Rename the auth cookie to `__Host-token`

The `__Host-` prefix makes browsers refuse the cookie unless it's Secure,
path `/`, and has no Domain — which stops a sibling subdomain from planting one.
One-line change in `routes/auth.ts` plus `requireAuth`; the cost is that
everyone is signed out once when it ships, since the old cookie name is ignored.

## Serve photos at the size they're shown (the big one)

**Why.** Uploads are stored exactly as received (`routes/minis.ts`, multer
`diskStorage` — nothing resizes them) up to a 10 MB cap, and a card renders the
original into a 180px box (`DashboardPage.tsx:216`). A phone camera photo is
3–5 MB and 12 MP. Thirty minis on the browse page is 100 MB+ over cellular and
thirty full-resolution decodes (~48 MB of bitmap each) — enough for mobile
Safari to kill the tab. Nobody sees this with test data on a LAN; everybody sees
it the first week real photos go in.

**How.** Both halves are worth doing:
1. Shrink in the browser before upload (canvas re-encode) — no new dependency,
   no Pi CPU, and much faster uploads over cellular.
2. Resize on the server with `sharp`: a ~400px WebP thumbnail for cards and a
   ~1600px copy for the detail view, keeping the original. ~300–600 ms per photo
   on an A72, on a path that's already slow. **Call `.rotate()` first** or
   EXIF-oriented iPhone photos come out sideways.

Then `loading="lazy"`, `decoding="async"`, and explicit width/height on the card
`<img>` — nearly free, and stops fetching thirty photos for a screen showing six.

## Bound the browse and loans payloads

- `GET /api/minis` returns the whole collection including full 5000-char
  descriptions (~1 MB of JSON at 200 minis). Paginate (keyset on `created_at`),
  and leave descriptions out of the list — only the detail view needs them.
- `GET /api/loans` returns *every* loan ever for that user in that collection
  (`routes/loans.ts:46-56`, no status filter or limit) and the Loans page polls
  it every 30 s. Split active from history and paginate the history.

Two related items — response compression, and cache headers on the built
frontend — are *done*: `compression({ level: 4 })` in `app.ts`, mounted after
`/uploads` so it never touches already-compressed photos; `/assets/*` gets
`immutable, max-age=1y` and `index.html` gets `no-cache` (on both the path
`express.static` serves it from and the SPA-fallback route), closing the
white-screen-after-deploy bug. Neither one shrinks the *number* of bytes a
response has to have in the first place — that's still pagination, above.

## Make search cheap

`GET /api/minis` reads the whole collection, then fuzzy-matches in this process:
Levenshtein against every word of every description (`utils/search.ts:35-45`,
descriptions up to 5000 chars). At 200 minis that's ~160k comparisons **per
keystroke**, on the one core, blocking every other request. The search box has
no debounce either (`DashboardPage.tsx:101`) — one full query per character.
`BROWSE_MAX_PER_MINUTE` now caps the damage, but the fix is: debounce 250–300 ms,
restrict fuzzy matching to name + tags, and let SQL `LIKE` cover descriptions
with fuzzy as the fallback when nothing matches.

## Guard against out-of-order search responses

`fetchMinis` calls `setMinis` unconditionally (`DashboardPage.tsx:31`) with no
`AbortController` and no sequence check. On a mobile connection a slow response
for "owl" can land after the fast one for "owlbear", leaving the grid showing
results that don't match the box. Abort the previous request, or ignore any
response that isn't for the current query.

## Make the pollers visibility-aware

Three intervals — notifications 60 s, cart 60 s, loans 30 s — each costing a
session lookup plus a membership check plus the payload query. They keep firing
on hidden desktop tabs and, on a phone returning from sleep, show stale data for
up to a minute. Pause on `document.hidden`, refresh on `visibilitychange`. A
single `/api/summary` returning `{unread, cartCount}` would halve the requests.

## Back up the Pi

Neither `scripts/rpi-setup.sh` nor `scripts/rpi-update.sh` takes a backup, and
the photos sit on the same SD card as the database. SD cards in always-on Pis
fail from write wear. Today one failure loses every mini, photo, and loan record.
Nightly `mysqldump | gzip` plus a `tar` of `uploads/`, off the box — and test a
restore once, because an untested backup isn't one.

Related: `rpi-update.sh` runs `npm run install:all`, a Vite build, and `tsc` on
the Pi, which already runs at ~3.2 GB of 3.7 GB with swap full. A build spike
can OOM mid-deploy and leave a half-written `dist/`. Either build elsewhere and
rsync `dist/`, or stop the service and give the box 2 GB of swap first. The
`systemctl restart mariadb` on every deploy (`rpi-update.sh:64`) also costs
10–30 s of downtime for something probably not needed.

## Considered and deliberately not done: batching the hourly loops

`notifyOverdueLoans` (`services/loanEvents.ts:137`) does three queries per newly
overdue loan, and member removal promotes holds one mini at a time
(`services/membership.ts:87`). Both look like N+1s and both should stay as they
are. The per-row `UPDATE ... WHERE overdue_notified_at IS NULL` is what makes
two overlapping sweeps unable to announce the same loan twice; batching it needs
a claim token and loses that obviousness. The hold promotions each run in a
transaction that locks one mini row — batching would widen the lock. They run
hourly (or on an admin action) over a handful of rows. Revisit only if a
collection reaches hundreds of active loans. `notify()` already batches its
inserts across recipients.

## Three hand-maintained "every table" lists keep drifting

Adding the `sets` table (feature 4) exposed the same mistake three separate
times: `backend/src/test/dbHelpers.ts`'s `resetDatabase()`,
`minis.integration.test.ts`'s local `beforeEach`, and `tests/support/seed.cjs`'s
`resetData()` each hand-list every table to wipe between tests, and none of
them got the new table added automatically. The `dbHelpers` and `seed.cjs`
misses were real and silent — e2e sets accumulated across an entire test run
until a name collision (two tests both using "Squad") caused a strict-mode
double-match, which is how it was caught. That's luck, not a guarantee.

The other two mirror-drift bugs this project already hit (`schema.sql` vs
migrations; `frontend/src/limits.ts` vs the server) both got a test that
fails loudly the moment they disagree. This is the same shape of problem and
doesn't have one yet. Worth building: one exported `ALL_TABLES` list (derived
from `information_schema.TABLES` at test time, or hand-maintained in exactly
one place) that every cleanup helper imports, so a new table can only ever be
forgotten once.

## Grouping the unit tests

Test files sit next to the code they test (65 test files against 74 source
files). WebStorm's File Nesting collapses them in the project view, which is
the current answer. If that stops being enough, move the 11 database-backed
`*.integration.test.ts` files to `backend/tests/integration/` — they're the
bulky ones, and they're run separately anyway. Moving *all* unit tests was
considered and rejected: it loses the at-a-glance "this module has no test"
signal.
