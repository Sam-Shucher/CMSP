# Backlog

Things deliberately deferred, with enough context to pick them up cold.

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

## Grouping the unit tests

Test files sit next to the code they test (65 test files against 74 source
files). WebStorm's File Nesting collapses them in the project view, which is
the current answer. If that stops being enough, move the 11 database-backed
`*.integration.test.ts` files to `backend/tests/integration/` — they're the
bulky ones, and they're run separately anyway. Moving *all* unit tests was
considered and rejected: it loses the at-a-glance "this module has no test"
signal.
