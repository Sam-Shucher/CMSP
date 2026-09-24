# Backlog

Things deliberately deferred, with enough context to pick them up cold.

## Feature ideas

Numbered so they can be referred to by number in conversation. The numbers are
stable names, not an order of priority — 1 and 2 are simply the two picked up
first. Status is marked where work has started.

**Smaller, self-contained:**

1. **Renew / extend a loan** — *done*. A borrower (or the owner) keeps a mini
   longer without cancelling and re-requesting. Blocked while anyone is in the
   hold line, the way a library refuses a rene/clauwal on a reserved book. Bounded by
   the same three months as any loan, counted from the handoff.
2. **Sort and filter the browse page** — *done*. Available-only checkbox, an
   owner dropdown (`GET /api/minis/owners`), and sort by newest/name/price,
   alongside the existing search and tag pill.
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
5. **Transfer ownership** — *done*. Owner (or an admin) picks another member
   on the edit page (`POST /api/minis/:id/transfer`); keeps tags, photos,
   price, and lending history — blocked while the mini has an active request/
   loan or is out on a quest, and it leaves any set it was part of (sets are
   one owner's own minis).
6. **Lost / damaged as a loan outcome** — *done*. Two more ways `POST /api/loans/:id/return`
   can end a loan (`{ outcome: 'lost' | 'critically_wounded' }`, next to the
   default `'returned'`): the mini never comes back, or comes back broken —
   "Critically Wounded" is this app's name for damaged. Either way the mini
   is hidden from browse (`minis.condition_flag`/`condition_since`, a
   separate concept from item 8's `archived_at` — the owner keeps full
   access to see and clear it); `critically_wounded` needs the owner (or an
   admin) to explicitly clear it from the mini's edit page before it can be
   lent again, `lost` has nothing to restore but can be cleared the same way
   if it turns up. Who was responsible for a given incident is visible only
   to that mini's owner and admins (`GET /api/minis/:id/history`'s existing
   scoping); a private, admin-only tally per borrower
   (`GET /api/admin/loan-incidents`) makes a repeated pattern visible without
   it being a public reliability score — same reasoning as the "decided
   against" entry below.
7. **Admin audit log** — *done*. A collection-scoped `audit_log` table records
   who did what and when — currently just member removals and mini restores —
   shown on the Admin page. Actor/target names are snapshotted at the time of
   the action (`SET NULL` FKs, not `CASCADE`), so an entry survives the
   account it's about being deleted, which happens routinely here.
8. **Grace period on member removal** — *done*. A removed member's minis are
   archived (hidden everywhere, restorable) instead of deleted outright, as
   long as they still belong to another collection — an admin can give one
   back to a current member from the new "Archived Minis" section before
   `maintenance/housekeeping.ts` purges it 30 days later
   (`MINI_ARCHIVE_GRACE_DAYS`). If the group removed from was their *last*
   one, the account and its minis are still deleted immediately, same as
   before — deferring that too would leave a zero-collection account
   dangling for no real benefit here, so the grace period only covers the
   case where they survive the removal. Their **sets** are archived with
   their minis (`sets.archived_at`, migration 021): hidden from the Sets
   page, back if a mini is restored to its original owner, purged with the
   minis when the grace period ends.
9. **Export my collection** — *done*. "Export my minis" on the Profile page
   (`GET /api/export`) downloads a `.zip` of the caller's own minis in the
   group they're in: `minis.csv` in Bulk Add's columns (15) so it goes straight
   back in, here or in another group; `minis.json` with the full record
   (condition, set, lending history — the owner already sees that history, 3);
   and every photo. **No new dependency:** a small stored-only ZIP writer
   (`utils/zip.ts`) streams it one photo at a time, since photos don't
   compress and the Pi's core shouldn't try. It's a link, not a fetch, so a
   big export goes to disk rather than a phone's memory; the link carries
   `?group=` so a switch in another tab is refused (409) instead of handing
   over the other group's minis. Six an hour per person. Not a restore path
   for the whole site — that's "Back up the Pi" below — but one person's
   minis survive the SD card.

10 and 11 were taken off the list on 2026-09-23 — see "Removed from the list"
below. Their numbers stay retired so older conversations still make sense.

**Larger, would change how the app is used** (12, 13, 15, and 16 are done; the rest stand):

12. **Condition record at handoff and return** — *done*. A note (up to 1000
    chars) and up to three photos at each end of a loan
    (`POST /api/loans/:id/condition`, `loan_condition_reports` +
    `loan_condition_photos`), so "the spear was already bent" is a fact instead
    of an argument. **One report per person per end**, and none can be edited
    or replaced — a record that can be rewritten later isn't one. A *return*
    report stays fileable after the loan ends (the owner only has it back in
    hand then); a *handoff* report closes when the loan does, because a fresh
    claim about the handoff made once the mini is back and broken is exactly
    the argument this replaces. Condition photos go through the same upload
    pipeline as a mini's (extracted to `middleware/uploads.ts`) but are served
    only to the loan's two people, not the whole collection
    (`requireImageAccess`), and are in the housekeeping sweep's in-use query.
    The return stays open for **12 hours** after the loan ends
    (`RETURN_NOTE_HOURS`) — long enough to look it over at home, short enough
    that it's about the return and not the shelf afterwards.
13. **Booking for a date** — *done*. A claim on a range of days
    (`bookings`, `POST /api/bookings/minis/:id`) — "I need it for game night on
    the 14th" — which is what a hold can't express. **A mini that's out** —
    lent, or on a quest with its owner, which counts the same — can be booked
    only from the **day after** it's due back (an overdue one: from tomorrow),
    and the booking panel says so before anyone picks a day; a quest with no
    back-by date can't be booked at all, only held. Taking a mini on a quest
    has to bring it back before anyone's booked day, like a loan.
    **No two bookings on one mini may overlap**, enforced
    in a transaction that locks the mini row, same as the hold line; one
    booking per person per mini, ten per mini, three months long, six months
    ahead. *How it meets the hold line:* it doesn't compete with it. A hold
    decides **who** is next; a booking constrains the **calendar** — a handoff
    or extension whose due date would still have the mini out when someone
    else's window begins is refused (`services/bookings.ts`'s
    `bookingBlocking`). A hold promotion makes a request with no duration yet,
    so it never conflicts on its own. *No-shows:* housekeeping turns a booking
    into a request on its first day (`startDueBookings`), retrying hourly if
    the mini is still out, and sweeps a window that passed without that,
    telling the person it never came free (`sweepPastBookings`) — unless they
    had it all along, in which case their own loan fulfils the booking quietly.
    **The hold line always goes first** when a mini comes home, by design: the
    queue is the queue, and a booking only limits how long that next loan can
    run. All of a booking's days are the group's days (`APP_TIMEZONE`, see
    `utils/appTime.ts`), never the database's `CURDATE()` or UTC.
14. **Web Push and a PWA install** — *done*. A manifest, icons and a service
    worker (`frontend/public/sw.js`, which shows notifications and caches
    nothing) make "Add to Home Screen" a real app. `push_subscriptions`
    (migration 020) holds one row per device; `notify()` sends every bell
    notice to the recipients' devices (`services/push.ts`, `web-push`),
    titled with the group, never awaited and never throwing. Turned on per
    device on the Profile page (`POST`/`DELETE /api/push/subscriptions`,
    `POST /api/push/test`). **Endpoints are only accepted on the four browser
    push services** — the Pi POSTs to whatever is stored. The browser's
    subscription belongs to the device and survives sign-out; the server row
    says whose notices go there and **which sign-in** turned them on
    (migration 021's `session_id`): nothing is sent once that session has
    expired, gone idle or been signed out, and the row goes when the session
    is purged. `resyncPush` re-attaches it on the next sign-in. A
    loan's messages share one tag/topic, so they replace each other like the
    bell's entry. The VAPID pair is generated by `rpi-update.sh`; push stays
    off (logged at startup) until `FRONTEND_URL` is https. The app icon shows
    the unread count where `setAppBadge` exists. **One group at a time**
    (2026-09-23): a device gets only the notices of the group its sign-in is
    in (`sessions.collection_id`, migration 023 — kept in step with the cookie
    by `touchSession`, set at once by `select-collection`), same as the bell.
    The other group's notices wait in its bell until they switch. This closed
    the old gap where tapping a notice from the other group opened the Loans
    page of the group they were in.
15. **Bulk add** — *done*. `/upload/bulk` (linked from Add Mini) takes both:
    drop a pile of photos, one mini each, named as you go (a meaningful
    filename pre-fills it; `IMG_4412` doesn't), with "put the photos with the
    mini above" for a mini shot from several sides; or a CSV file / cells
    pasted from a spreadsheet, by a header row (`name` required;
    `description`, `tags`, `price` optional). **No new endpoint:** every row is
    checked in the browser, then sent one at a time through the existing
    `POST /api/minis` — the Pi has one core, every server-side rule and the
    upload pipeline apply unchanged, and a refused row stays on the page with
    its reason while the rest still go in. Capped at 100 rows per batch
    (frontend only; it's a page limit, not a server one).
16. **A message thread per loan** — *done*. `loan_messages`
    (`GET`/`POST /api/loans/:id/messages`, `POST .../messages/read`), visible
    only to the loan's two people. **Open while the loan is active; read-only
    once it ends** — the thread is a record of what was agreed, like a
    condition report, so messages are never edited or deleted. Each message
    has exactly one reader, so `read_at` on the message is the whole "Seen" /
    unread story. The bell gets one entry per conversation: a new message
    replaces the other person's *unread* `loan_message` notice for that loan
    (`services/loanEvents.ts`'s `messagePosted`), and marking the thread read
    marks that notice read. 500 messages per loan, so a stuck client can't
    grow one without bound. An open thread reloads when the Loans page's
    30-second poll shows the count grew — or at once, when a push arrives
    while the site is open (14).
17. **Toggle price visibility per collection** — *done*. Some groups don't want
    a dollar figure on every mini at all. `collections.show_prices` (migration
    019), switched by an admin under Group Settings on the Admin page
    (`PATCH /api/admin/settings { showPrices }`). `requireCollectionMembership`
    loads it with the role, so with it off the server sends `price: null`
    everywhere (browse, a mini, sets, archived minis), treats `sort=price` as
    newest, and neither checks nor saves a submitted price — an edit leaves the
    stored price alone, so turning it back on brings every price back. The
    frontend reads it from `GET /api/auth/collections` (`showPrices`) to drop
    the price field (single and bulk add, edit) and the "Price" sort option.

**Suggested 2026-09-23, not started:**

18. **"Due tomorrow" reminder.** Today there's only the overdue notice. The
    hourly housekeeping sweep already has everything this needs — the same
    shape as `notifyOverdueLoans`, with its own "already told" column so two
    overlapping sweeps can't send it twice. Mind `APP_TIMEZONE`: "tomorrow" is
    the group's day, not UTC.
19. **Owner's "please bring it back" nudge** on a loan that's still running —
    one button on the owner's loan card, a notice (and so a push) to the
    borrower. Rate-limit it (once a day per loan) so it can't become nagging.
20. **Calendar feed (.ics)** of your bookings and due dates, to subscribe to
    from a phone's calendar. Needs a per-person secret URL, since a calendar
    app can't send the login cookie — and a way to reset that URL.

**Removed from the list** (2026-09-23 — not rejected on principle like the
ones below, just no longer planned; recorded here so the numbers aren't reused):

- ~~10. **QR labels**~~ — print a sheet, one per case, scan to open that mini.
  Very library, and genuinely good at a handoff.
- ~~11. **Wishlist**~~ — "looking for a Beholder", and owners see the matches.

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

## Loans vanish when the other person's account is deleted

A bug, found 2026-09-23 and not yet fixed. Since migration 022 a loan outlives
a deleted account (`borrower_id`/`owner_id` go NULL, the name is kept in
`removed_borrower_name`/`removed_owner_name`). But `LOAN_SELECT` in
`routes/loans.ts` still uses an inner `JOIN users` for both people, so a loan
whose other person has gone drops out of the remaining person's Loans page and
history entirely. Fix: `LEFT JOIN users` for both, and
`COALESCE(b.display_name, l.removed_borrower_name)` (likewise for the owner)
— the rule CLAUDE.md already states. Test it in `loans.integration.test.ts`:
delete the borrower's account, then the owner's `GET /api/loans` and
`/api/loans/history` should still list the loan under the saved name.

## Upgrade react-router

`react-router` had two moderate advisories when last checked (2026-09). They
don't affect this app — every navigation goes to a fixed path, never one
built from user input — so it waits for a convenient moment. Run
`npm --prefix frontend audit` to see whether they're still open, and upgrade
within 6.x if so.

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

## Serve photos at the size they're shown (the big one) — *browser half done*

**Done (2026-09-23):** photos are shrunk in the browser before upload
(`frontend/src/utils/photoFiles.ts`'s `preparePhotos` / `shrinkPhoto`) —
longest side 1600px, JPEG stays JPEG at 0.85, anything else becomes WebP
(keeps transparency; a browser that can't encode WebP hands back PNG). GIFs,
photos already under 1600px and 1 MB, and anything the browser can't read are
sent untouched. Drawn from an `<img>`, so EXIF orientation is applied. One
photo at a time, since a full-size decode is ~48 MB on a phone. Used by Add /
Edit Mini, Bulk Add, and condition photos; the 10 MB cap now applies to the
shrunk file. Card, loan and cart thumbnails have `loading="lazy"` and
`decoding="async"`. **Still open:** photos uploaded before this stay full size,
and a card still downloads the 1600px copy — the server-side `sharp` thumbnail
below is what fixes both. It adds a native dependency on the Pi (check the
memory headroom first), so it was left for its own change.

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

## Bound the browse and loans payloads — *paging done*

**Done (2026-09-23):** `GET /api/minis` returns a page of 60
(`BROWSE_PAGE_SIZE`); the next page is the same query plus `after=<the last
mini's id>` — keyset paging, with the server looking up where that mini sorts
in the chosen order (inside the caller's group only), so it works for all three
sorts and nothing shifts when a mini is added meanwhile. Search still matches
in JS, so for a search the database reads on from the cursor and the page is
cut from the matches. `GET /api/loans` is every open loan plus the latest 20
finished ones, in one query; `GET /api/loans/history?before=<loan id>` pages
back (the cursor must be one of the caller's own loans). Browse has "Load
more", Loans has "Show older", Sets asks for `?owner=<me>` page by page. Page
sizes are mirrored in `frontend/src/limits.ts` (`PAGE_SIZE`) and pinned by
`limitsMirror.test.ts`. **Still open:** descriptions still ride along in the
list; dropping them means the detail view fetching `GET /api/minis/:id`.

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

## Guard against out-of-order search responses — *done*

**Done (2026-09-23)** with paging: `DashboardPage` numbers each list request
(`listVersion`) and drops a response for filters that have since changed —
the same check stops a "Load more" for the old filters landing in the new list.

`fetchMinis` calls `setMinis` unconditionally (`DashboardPage.tsx:31`) with no
`AbortController` and no sequence check. On a mobile connection a slow response
for "owl" can land after the fast one for "owlbear", leaving the grid showing
results that don't match the box. Abort the previous request, or ignore any
response that isn't for the current query.

## Make the pollers visibility-aware — *done*

**Done (2026-09-23):** `frontend/src/hooks/usePollWhileVisible.ts` — the bell,
the cart count and the Loans page make no requests while the tab is hidden,
and check at once when it's shown again. Also done: each request's access
check is now one query, not two — `touchSession` reads the caller's membership
of the cookie's group in the same query as the session (`LEFT JOIN`), and
`requireCollectionMembership` uses that answer (`req.groupAccess`), querying
only when it wasn't read. **Still open:** the single `/api/summary` below.

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
