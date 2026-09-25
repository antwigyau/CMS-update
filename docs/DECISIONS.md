# Architecture decision log

One entry per decision that would be expensive to reverse or surprising to a new reader.
Newest last. "Approved" means the project owner explicitly chose it.

---

## ADR-001 — Backend-for-Frontend, not browser-to-Supabase

**Status:** approved 2026-08-26 · **Phase:** 1

The browser talks only to `/api` on its own origin. The API layer holds the Supabase
credentials and queries Supabase on the user's behalf.

**Why:** the conventional Supabase pattern puts the anon key and both session tokens in the
browser, where any injected script can read the refresh token. It also leaves no server-side
place to write audit rows the client cannot forge, or to aggregate report data without
shipping rows to the browser. The project spec asks for a "Secure Server/API Layer" in §3.

**Cost, accepted:** one extra network hop, and we implement token refresh ourselves.

**Rejected:** direct browser-to-Supabase with RLS as the only guard.

---

## ADR-002 — One serverless function, with `?path=` as a routing fallback

**Status:** accepted · **Phase:** 1

All `/api/*` traffic is rewritten to `api/index.js`, which dispatches through a route table.

**Why:** verified against Vercel's documentation — a project without a framework maps each
file in `api/` to one function, and **Hobby is capped at 12 functions per deployment**. One
file per endpoint would hit that ceiling around the time Members and Attendance both exist.
One function also means one warm instance and one place for shared middleware.

**The `?path=$1` capture:** the rewrite destination is `/api/index?path=$1`. `resolvePath()`
prefers the real pathname and uses the query capture only if the pathname arrives as the
function entrypoint. This means routing works whether or not Vercel preserves the original
pathname through the rewrite — which could not be verified locally — and a client cannot spoof
a route by appending its own `?path=`, because the pathname wins.

**To verify on first deploy:** which of the two branches actually fires in production.

---

## ADR-003 — Session tokens in HttpOnly cookies

**Status:** approved 2026-08-26 · **Phase:** 3 (design fixed now)

`cma_at` (access token) and `cma_rt` (refresh token) are `HttpOnly; Secure`; `cma_rt` is
additionally scoped to `Path=/api/auth` so it is not transmitted on ordinary API calls. A
third cookie, `cma_csrf`, is readable by JavaScript **by design** — it is a CSRF token, not a
credential, and is useless without the other two.

**Why:** JavaScript cannot read the session, so an XSS bug cannot exfiltrate it.

---

## ADR-004 — No web framework; a table-driven router that denies by default

**Status:** accepted · **Phase:** 1

`src/server/router.js` is ~120 lines and replaces Express.

**Why:** Express would add a dependency and a second routing concept without earning either.
More importantly, the hand-written router enforces something a framework does not: every
route must declare `public: true` or a `permission`, and a permissioned route **cannot be
registered** until the session and permission guards are supplied. Both violations throw at
cold start. An endpoint therefore cannot reach production unprotected by omission.

---

## ADR-005 — Bootstrap vendored at build time, not committed and not from a CDN

**Status:** accepted · **Phase:** 1

`npm run vendor:refresh` copies Bootstrap out of `node_modules` into
`public/assets/vendor/`; it is the Vercel build command, and the directory is gitignored.

**Why not a CDN:** the CSP is `script-src 'self'` / `style-src 'self'`. A CDN would mean
widening the policy to a third-party origin and depending on that origin's uptime.
**Why not commit the files:** the version would then live in two places and the committed
copy would go stale. This way `package.json` is the only source of the version.

**Cost, accepted:** the project has a build step, contrary to the "no build step" line in the
original blueprint. It is a five-file copy.

---

## ADR-006 — Strict CSP, and the three consequences we accepted for it

**Status:** accepted · **Phase:** 1

`default-src 'self'; script-src 'self'; style-src 'self'; …` with no `unsafe-inline`.

Consequences, all deliberate:

1. **No inline `<script>`.** Theme selection must happen before first paint to avoid a flash
   of the wrong colour scheme, which is normally done with an inline script. Instead
   `core/theme-boot.js` is a tiny same-origin classic script in `<head>`.
2. **No `style=""` attributes** — `style-src-attr` falls back to `style-src`, so inline style
   attributes are blocked too. `el()` throws if given a `style` attribute, and a test scans
   every HTML file for one.
3. **`img-src` allows `https://*.supabase.co`** so signed Storage URLs render directly. The
   alternative was proxying every member photo through the API, at one function invocation
   per avatar. Revisit if the storage origin ever needs hiding.

---

## ADR-007 — Multi-branch schema, single-branch UI

**Status:** approved 2026-08-26 (decision D2) · **Phase:** 2

`branch_id` appears on every branch-scoped table from the first migration, and `branches` is
seeded with one row. No branch switcher is built.

**Why:** retrofitting a tenant column into a live schema means migrating every table and
rewriting every RLS policy. Adding the column now costs almost nothing.

---

## ADR-008 — Every financial transaction requires approval

**Status:** approved 2026-08-26 (decision D3) · **Phase:** 10

Income and expenses alike move `draft → pending_approval → approved`, with `rejected` and
`void` as terminal states. **Only `approved` rows count toward any report or dashboard total.**
Amount, kind, category, date, and member attribution become immutable once a row leaves
`draft`/`rejected`. There is no `DELETE` — an approved transaction is reversed by voiding it.

**Consequence, flagged to the owner:** a Sunday offering does not appear in any total until a
second authorised person approves it, so the approval queue becomes a routine weekly task and
at least two staff accounts must hold finance permissions.

**Resolved by ADR-015:** who holds `finance.approve` / `finance.reject` / `finance.void`, and
whether a submitter may approve their own entry.

---

## ADR-009 — Member logins are admin-created; giving history is not exposed

**Status:** approved 2026-08-26 (decision D4) · **Phase:** 3

No public self-registration. A staff user creates the account; the member can see their own
profile and their own attendance history. Their tithe and offering records are **not** visible
to them in the MVP.

**Why no self-registration:** open sign-up on a system holding member PII is an attack surface
with no owner. If public registration is wanted later, it should create unverified _applicant_
records requiring staff approval, not real accounts.

---

## ADR-010 — A zero-dependency local dev server instead of `vercel dev`

**Status:** accepted · **Phase:** 1

`scripts/dev-server.mjs` serves `public/` and routes `/api/*` into the same
`handleRequest(Request) → Response` that the Vercel function calls.

**Why:** it needs no CLI login, no Docker, and no network, and it applies the same security
headers — so a CSP violation surfaces on localhost instead of after a deploy. Because
`handleRequest` is host-independent, the test suite calls it directly with no server at all.

`vercel dev` remains useful for verifying the rewrite and platform behaviour before shipping.

---

## ADR-011 — Short asset cache TTL instead of hashed query strings

**Status:** accepted · **Phase:** 1 · _changes the original blueprint_

Assets are served `public, max-age=600, stale-while-revalidate=86400`. HTML is
`max-age=0, must-revalidate`.

**Why:** the blueprint proposed `?v=<hash>` cache-busting maintained by a script. A ten-minute
TTL achieves the same practical result with no machinery and no risk of a cached HTML page
pointing at a stale asset URL. Revisit only if measurement shows it matters.

---

## ADR-012 — ESLint 10

**Status:** accepted · **Phase:** 1

`eslint@9` installs with a deprecation notice — 9.x is now maintenance-only — so the project
uses ESLint 10 with flat config.

---

## ADR-013 — The deep health probe is refused in production

**Status:** accepted · **Phase:** 1, revisit in Phase 4

`GET /api/health?deep=1` makes an outbound request to Supabase, so an anonymous caller could
use it to generate load against our own database host. It returns 403 in production until
Phase 4 provides a permission (`settings.view`) to guard it with. The shallow probe does no
I/O and stays public.

---

## ADR-014 — Attendance is recorded both by name and by headcount

**Status:** approved 2026-08-26 (decision D5) · **Phase:** 8

`attendance_sessions` carries `count_adults`, `count_youth`, `count_children`,
`count_visitors` (each `integer NOT NULL DEFAULT 0 CHECK (>= 0)`) alongside the named rows in
`attendance_records`.

**Why both:** the named roll drives follow-up ("who has not attended in six weeks"); the
headcount is the true total, because nobody identifies 200 people at the door. Reports show
both — "212 present, 148 identified" — rather than implying the named count is the attendance.

**Deliberately not constrained:** there is no `CHECK` forcing the headcount to be at least the
named count. Ushers capture the two independently and reconciling them is a human task; a
constraint here would reject honest data entry.

---

## ADR-015 — Senior Pastor and Super Admin approve; nobody approves their own entry

**Status:** approved 2026-08-26 (decision D6) · **Phase:** 10

`finance.submit` goes to the Finance Officer and Super Admin. `finance.approve`,
`finance.reject`, and `finance.void` go to the Senior Pastor and Super Admin only — the
Finance Officer does **not** hold them. Enforced in the schema by
`CHECK (approved_by is null or approved_by <> submitted_by)`.

**Why the constraint and not just the permission split:** a Super Admin holds both `submit`
and `approve`, so permissions alone would let one person do the whole cycle. The constraint is
what makes the second signature real, and it lives in the database so no API bug can skip it.

**Consequence:** if the Senior Pastor is unavailable and only one Super Admin exists, entries
queue up. That is the intended behaviour of a two-person control, not a defect.

---

## ADR-016 — Spiritual gifts are a controlled list, not free text

**Status:** approved 2026-08-26 (decision D7) · **Phase:** 5

`spiritual_gifts(name unique, description)` with a `member_spiritual_gifts` join table. The
member `notes` free-text field is retained.

**Why:** "who has the gift of teaching" must be an indexed query. Free text turns it into a
search across "Teaching", "teaching", and "Teacher", and gift-based ministry reporting stops
working. The trade is that adding a new gift is an insert rather than typing — which is the
correct friction for a reporting dimension.

---

## ADR-017 — Local Supabase stack via Docker, not a shared cloud dev project

**Status:** approved 2026-08-26 (decision D8) · **Phase:** 2

Development and testing run against `supabase start` on Docker Desktop.

**Why:** pgTAP RLS tests execute inside the database, which is the only way to prove a policy
actually blocks a role rather than merely that our API returns 403. Running them against a
shared cloud project means tests mutate data other people are using, and development stops
working without a network. Docker Desktop is therefore a prerequisite for Phase 2.

**Superseded in part by ADR-019:** Docker was not installed when Phase 2 was written, so the
schema is verified with PGlite in the meantime. Docker remains the target.

---

## ADR-018 — Composite foreign keys keep branches from mixing

**Status:** accepted · **Phase:** 2

Join tables between two branch-scoped entities carry their own `branch_id` and reference both
parents compositely: `(family_id, branch_id) references families (id, branch_id)`. Applies to
`family_members`, `ministry_members`, `attendance_records`, and `event_registrations`.

**Why:** with multi-branch data in one schema (D2), the failure that matters is not "a user
saw the wrong branch" — RLS handles that — but "a row now belongs to two branches at once",
which no amount of policy work detects afterwards. The composite key makes it a referential
integrity error at write time. Tests confirm that putting a West Branch member into a Main
Branch family is refused whichever `branch_id` the caller claims.

**Cost, accepted:** one denormalised column per join table.

---

## ADR-019 — The schema is verified with PGlite until Docker is available

**Status:** accepted · **Phase:** 2 · _deviates from the blueprint's pgTAP plan_

`tests/db/` applies every migration and the seed to PGlite — PostgreSQL compiled to
WebAssembly, running in the test process — then exercises the schema as each role.
`tests/db/shims.sql` reproduces the parts of Supabase the schema depends on: the
`anon`/`authenticated`/`service_role` roles **and Supabase's default table grants**,
`auth.uid()` reading `request.jwt.claims`, `auth.users`, and the `storage` tables.

**Why:** the blueprint planned pgTAP via `supabase test db`, which needs Docker, which is not
installed. The alternative was to hand over roughly two thousand lines of SQL that had never
been parsed. This way the DDL is executed, the constraints are exercised, and the RLS policies
are tested as each role.

**Why the default grants matter:** without them, `set role authenticated` would be refused by
table privileges and every RLS test would pass for the wrong reason. Reproducing Supabase's
broad grants is what makes RLS load-bearing in the test, exactly as in production.

**What it does not prove:** GoTrue (sign-in, tokens, password hashing, email), Supabase
Storage's own MIME and size enforcement, PostgREST request handling, and Supabase's security
advisors. Those need `supabase start`. The full list is at the top of `shims.sql`.

**It has already paid for itself:** it caught `now()` in an index predicate — STABLE, not
IMMUTABLE, which real PostgreSQL rejects too.

---

## ADR-020 — A ministry leader's authority comes from row-level scope, never a branch grant

**Status:** accepted · **Phase:** 2 · _found by a failing test_

The `ministry_leader` and `choir_leader` roles hold only READ permissions branch-wide
(`ministries.view`, `events.view`, `members.view_directory`, two report permissions). Everything
a leader _does_ — managing their ministry's membership, opening its register, marking
attendance, creating its events — comes from `app.is_ministry_leader()` and
`app.leads_session_ministry()` in the policies.

**Why:** the first draft granted the role `ministries.members.manage`, `attendance.record`,
`attendance.session.create`, `events.create`, and `events.update` at branch scope, on the
assumption that the policies' leadership branch would narrow them. It does not — the policies
are `permission OR leadership`, so a branch-wide grant subsumes the scope entirely. The choir
leader could have added members to the ushering team and taken the Sunday service register.

An RLS test caught it, and a second test now asserts the role holds none of those keys, so the
regression cannot come back quietly. This is the general lesson for the permission model:
**"OR leadership" widens, it never narrows.**

---

## ADR-021 — Attendance records are frozen by closing the session, not by a timer

**Status:** accepted · **Phase:** 2

`attendance_sessions.status = 'closed'` makes its records immutable through a trigger, and
reopening requires `attendance.session.close`.

**Why:** an attendance register needs a point after which it is a record rather than a working
document, but that point is a human decision — a session may legitimately stay open all
morning, and a correction ten minutes later is normal. Tying immutability to an explicit close,
with a separate permission to undo it, matches how the register is actually used.

---

## ADR-022 — Refreshing happens on one endpoint only

**Status:** accepted · **Phase:** 3

`GET /api/auth/session` is the only route that will exchange a refresh token. Every other
route accepts a valid access token and returns 401 for an expired one. The client calls the
session endpoint on a ten-minute timer, and once after any 401 before retrying.

**Why:** GoTrue rotates refresh tokens, so a token can be redeemed once. In a serverless
environment several concurrent requests from one browser each see the same nearly-expired
access token; if each refreshed, all but one rotation would be invalidated and the user would
be signed out mid-session. Funnelling refreshes through a single endpoint the client calls
deliberately removes the race.

**Cost, accepted:** a request arriving between token expiry and the next session call gets one 401. That is a refresh-and-retry, not a logout.

---

## ADR-023 — Permissions are read from the database on every request

**Status:** accepted · **Phase:** 3 · _defers a documented optimisation_

`app.my_permissions()` is called on each authenticated request rather than baking permissions
into the JWT via Supabase's Custom Access Token Hook.

**Why:** a revoked role takes effect on the very next request. With claims in the token, a
**role** change does not reach the JWT until a new token is issued — Supabase's own
documentation flags this — so a dismissed staff member would keep their access for up to the
token lifetime. For a system holding congregation data that is the wrong trade.

**Cost, accepted:** one extra round trip per authenticated request. Tested: a permission
revoked between two requests is reflected immediately.

**Revisit** if the round trip ever shows up in measurements, not before.

---

## ADR-024 — CSRF: double-submit token, with Origin as the pre-session fallback

**Status:** accepted · **Phase:** 3

State-changing requests must carry `X-CSRF-Token` matching the `cma_csrf` cookie. The
sign-in, logout, and password-reset endpoints pass `requireToken: false`, which means "verify
the token if one is present, otherwise rely on the Origin / Sec-Fetch-Site check".

**Why the exception:** there is no `cma_csrf` cookie before a session exists, so demanding one
would make signing in impossible. For logout it also turns "sign out when already signed out"
into a confusing 403 instead of a no-op.

**What that exposes, precisely:** login CSRF — an attacker can cause a victim's browser to
sign in as the attacker. It grants the attacker nothing and reveals nothing, and the Origin
check blocks it from any origin a browser labels. A session that exists is always
token-protected, because the cookie is then present.

**Sec-Fetch-Site is checked before Origin** because it distinguishes `same-origin` from
`same-site`, and `none` (a typed URL) is refused for a state-changing request.

---

## ADR-025 — `requireSession` enforces CSRF, rather than a separate guard

**Status:** accepted · **Phase:** 3

The session guard performs the CSRF check itself.

**Why:** as two guards, every future protected route would have to remember to include both,
and the failure mode of forgetting the second is invisible — the endpoint works, and is
exploitable. Coupling them means an authenticated mutation is CSRF-checked by construction.

**Consequence:** a route that genuinely must skip the check has to say so explicitly, which is
a visible, reviewable diff rather than an omission.

---

## ADR-026 — The login endpoint has a minimum response time

**Status:** accepted · **Phase:** 3

`POST /api/auth/login` never returns in less than 300 ms.

**Why:** GoTrue performs the deliberately slow password hash only when the account exists, so
a wrong email answers measurably faster than a wrong password. That difference turns the login
form into an account-enumeration oracle — on a church system, a way to ask "is this person a
member?". Levelling the floor closes the channel. A successful sign-in already exceeds it, so
nothing is slowed for a legitimate user.

**Also in service of this:** identical wording and status for both failure cases, asserted by a
test that compares the two responses.

---

## ADR-027 — Rate limiting is in-process for the MVP

**Status:** accepted · **Phase:** 3 · _known limitation, scheduled for Phase 13_

`createMemoryRateLimitStore()` holds a sliding window in the function instance's memory.
Limits: 10 sign-ins per 15 minutes, 5 reset requests per hour, 10 reset attempts per hour,
each keyed on both IP and email address.

**The limitation, stated plainly:** Vercel runs several instances, so an attacker spreading
attempts across them gets a multiple of the nominal limit. This is a brake on casual
credential stuffing, not a defence against a distributed attack.

**Why it is acceptable now rather than negligent:** Supabase Auth applies its own global
limits underneath, and the store is an injectable interface with three methods. Phase 13
substitutes a Postgres-backed implementation and nothing else changes.

**Not deferred silently** — it is in `README.md` and in `docs/SECURITY.md` as a known gap.

---

## ADR-028 — Password minimum of 12 characters, and no composition rules

**Status:** accepted · **Phase:** 3

Setting a password requires 12 characters. There is no requirement for mixed case, digits, or
symbols.

**Why 12:** this system holds personal data on a congregation, including minors. Eight
characters is no longer a meaningful barrier.

**Why no composition rules:** they push people towards `Password1!` — predictable, and no
stronger. Length is what helps, and a short phrase is both longer and easier to remember. This
follows current NIST guidance rather than habit.

Login itself accepts any non-empty string: the rule belongs where a password is _set_, or
existing accounts would be locked out by a policy change.

---

## ADR-029 — The deep health probe became a permissioned route

**Status:** accepted · **Phase:** 3 · _closes the Phase 1 placeholder in ADR-013_

`GET /api/health/deep` replaces `GET /api/health?deep=1` and requires `settings.view`.
`GET /api/health` stays public and does no I/O.

**Why:** ADR-013 refused the deep probe in production because there was no permission system
to guard it with, and an anonymous caller could otherwise use it to generate load against our
own database host. There is now, so the probe works in production for those authorised. It is
also the first permissioned route, which means the guard chain is exercised by the test suite
rather than only by future feature work.

---

## ADR-030 — The frontend never sees a token, and validates its own redirect

**Status:** accepted · **Phase:** 3

`GET /api/auth/session` returns the user and a flat list of permission keys. No access token,
no refresh token, no Supabase URL. A test asserts the login response body contains no
token-shaped string.

The sign-in page honours `?next=` only when it is an absolute same-origin path: `//evil.example`
and `https://evil.example` are both rejected in favour of `/dashboard`.

**Why the redirect check:** an open redirect on a _login_ page is how a phishing flow gets a
trustworthy-looking URL on our own domain.

**Navigation filtering is UX, not security.** The shell hides links the caller has no
permission for; every one of them leads to an endpoint that would refuse the request anyway,
and RLS refuses it again underneath.

---

## ADR-031 — Offset pagination, capped server-side, counted over the filtered query

**Status:** accepted · **Phase:** 5

`?page=` and `?pageSize=`, with `pageSize` capped at 100 in `readPagination()` and the total
taken from `count: 'exact'` on the same filtered query.

**Why offset and not keyset:** keyset is faster on deep pages but cannot answer "page 7 of 24"
or support a jump-to-page control, both of which the member list needs. At congregation scale —
thousands of rows — the offset cost is irrelevant, and the Phase 2 indexes cover the sort
orders the UI offers.

**Why the cap is server-side:** `?pageSize=100000` is the whole roll in one request, which §19
and §27 of the specification both forbid. A client-side limit is a suggestion.

**Why the count is over the filtered query:** a total taken from the unfiltered table would
make "24 pages" a lie as soon as a filter was applied, and the pager would offer empty pages.

**Nonsense input falls back rather than erroring.** `?page=abc` is a stale bookmark or an
edited URL, and page 1 is a more useful answer than a 422. The cap, not the validation, is what
protects the database.

---

## ADR-032 — Sort keys are an allow-list, never a column name from the client

**Status:** accepted · **Phase:** 5

`readSort()` maps a small set of keys (`name`, `joined`, `number`, `status`, `created`) to
column names, and falls back to the default for anything else.

**Why:** the column name reaches a query builder. Even through PostgREST, which will not
execute arbitrary SQL, an unrecognised column leaks the shape of the table through its error
messages — and a column the user should not be able to order by (`notes`) is an information
channel of its own. A test asserts that no input can produce a column outside the allow-list.

---

## ADR-033 — `.partial()` does not strip `.default()`, and that was a real bug

**Status:** accepted · **Phase:** 5 · _found by a failing test_

`memberFields` carries no defaults. The create schema adds them; the update schema does not.

**The bug:** the first version defined `membershipStatus: z.enum(...).default('visitor')` and
`isBaptized: z.boolean().default(false)` in the shared field set, and built the update schema
with `.partial()`. In zod, `.partial()` makes a field optional but leaves its default in place,
so **every PATCH produced `membership_status: 'visitor'` and `is_baptized: false`** — quietly
demoting an active member to a visitor on a change of address, and forgetting their baptism.

Nothing would have surfaced this in production except a member noticing their own record was
wrong. It was caught by a test asserting the exact patch object, and there is now a second test
named for the bug.

**The general lesson, worth keeping:** assert the payload sent to the database, not only the
status code that came back. A silent over-write returns 200.

---

## ADR-034 — Database errors are mapped by constraint name, which never appears in the message

**Status:** accepted · **Phase:** 5

`src/data/errors.js` maps a PostgreSQL error to an API error. A recognised constraint produces
a field-level message; the constraint name is used only to _choose_ it.

**Why:** `members_branch_email_key` tells an attacker there is a uniqueness rule on branch and
email. "A member in this branch already uses that email address" tells the user what to fix. A
test asserts the constraint name and the raw PostgreSQL text appear nowhere in the response.

Unrecognised errors become a 500 with a generic message, because an unfamiliar constraint is
more likely a bug in our code than a mistake in the user's input — and guessing produces a
misleading 422.

---

## ADR-035 — A row hidden by RLS is a 404, never a 403

**Status:** accepted · **Phase:** 5

`GET /api/members/:id` returns 404 both when the member does not exist and when the caller may
not see them.

**Why:** a 403 confirms the id is real. Iterating ids against an endpoint that distinguishes
the two cases reveals how many members a branch has and lets an attacker check whether a
specific record exists. The two must be indistinguishable.

**Consequence, accepted:** a genuinely confused user with insufficient permission is told the
record does not exist, which is less helpful than the truth. The list view is where they see
what they are entitled to.

---

## ADR-036 — List state lives in the URL

**Status:** accepted · **Phase:** 5

Search, status filter, sort, and page are query parameters, written with `pushState` and read
back on `popstate`.

**Why:** a filtered list becomes a shareable, bookmarkable link, the back button behaves as the
user expects, and a reload does not silently reset the view. It also means the frontend holds no
list state of its own to fall out of step with what is displayed.

**Consequence:** the debounce on the search box (300 ms) matters — without it, typing a surname
would push eight history entries and issue eight requests.

---

## ADR-037 — Households are hard-deleted; members are not

**Status:** accepted · **Phase:** 6

`DELETE /api/families/:id` really deletes the row, and its `family_members` rows cascade. Every
member record survives untouched.

**Why the asymmetry with members:** a member is a person, and their record is referenced by
attendance history and financial records — so removal is `deleted_at` and reversible. A
household is a _grouping_. Deleting one destroys no information about anybody; it only says
"these people are no longer recorded as living together". There is nothing to preserve, so a
soft delete would add a `deleted_at is null` filter to every household query for no benefit.

The confirmation dialog says exactly this, because "Delete household?" invites the fear that
the members go too.

---

## ADR-038 — The household head is a relationship row, not a column

**Status:** accepted · **Phase:** 6

`families` has no `head_member_id`. The head is the `family_members` row whose
`relationship = 'head'`, enforced unique per household by a partial index.

**Why:** a column would duplicate what the relationship row already says, and the two would
eventually disagree — a `head_member_id` pointing at someone whose relationship row says
'son' is a bug with no obvious owner. The API computes `head` on read for the UI's convenience,
which costs a `find()` over an array that is almost always under ten elements.

**Cost, accepted:** "who heads this household" is a scan of the membership rows rather than a
single column read. At household scale that is free.

---

## ADR-039 — Membership changes are guarded by `families.update`

**Status:** accepted · **Phase:** 6

Adding, re-labelling, and removing a household member all require `families.update`. There is
no `families.members.manage`.

**Why:** adding someone to a household _is_ editing that household. A separate permission
would be a distinction without a difference — one more thing to grant, and one more thing to
forget to grant, producing a user who can rename a household but not populate it.

Contrast `ministries.members.manage`, which does exist: ministry membership is managed by
ministry leaders who must not be able to edit the ministry's own record branch-wide. The
distinction there earns its keep; here it would not.

---

## ADR-040 — The branch of a membership row comes from the household, never the request

**Status:** accepted · **Phase:** 6

`POST /api/families/:id/members` reads the household first and writes _its_ `branch_id` onto the
`family_members` row. The payload schema has no `branchId` at all.

**Why:** `family_members` carries `branch_id` so the composite foreign keys can guarantee the
household and the member share a branch (ADR-018). That guarantee is only as good as the value
written — a caller who could nominate the branch could satisfy one foreign key while pointing
at a member in another branch. Reading it from the household closes that, and the fetch doubles
as the 404 for a household the caller may not see.

---

## ADR-041 — Household search is `ilike` with escaped wildcards, and no search vector

**Status:** accepted · **Phase:** 6

`families` has no generated `search_vector` and no GIN index. Search is
`ilike('family_name', '%…%')` with `%`, `_`, and `\` escaped in the caller's input.

**Why no search vector:** a congregation of 2,000 has perhaps 600 households, and the only
searchable field is the name. A generated column plus a GIN index would be machinery without a
return. Members earned theirs — six searchable fields and a roll an order of magnitude larger.

**Why the escaping:** without it a search for `%` matches every household and `_` matches any
character. Not dangerous — PostgREST parameterises the value — but it makes the search box feel
broken, and the fix is three `replaceAll` calls. The backslash is escaped first, or the escape
character itself would be escaped by a later pass and leave the wildcard live. A test covers
that ordering specifically.

---

## ADR-042 — Ministry leadership is carried in the session, and the router knows about it

**Status:** accepted · **Phase:** 7

`loadIdentity` fetches `app.my_led_ministry_ids()` alongside the profile and permissions, so
`session.ledMinistryIds` is available on every request. The router gains a second guard kind,
`guard: 'permissionOrLeadership'`, used by the three ministry routes a leader may reach.

**Why this was necessary at all.** A ministry leader holds no `ministries.update` or
`ministries.members.manage` at branch scope — ADR-020 established that granting either
branch-wide would let the choir leader manage the ushering team. Their authority comes from
`ministry_members`, and the RLS policies read `permission OR is_ministry_leader(id)`.

But `requirePermission` would have refused them at the API layer, **before RLS ever saw the
request**. The computed authority the database grants would have been unreachable through the
API. That is not a theoretical gap: it would have made the ministry-leader role useless, and the
Phase 2 RLS tests would still have passed, because they bypass the API entirely.

**Why in the session rather than queried per check:** the alternative is an RPC per authority
check — two or three per request for a page that reads a ministry and its members. The list is
small (a leader leads one or two ministries), it is already being fetched as part of identity,
and folding it into the same `Promise.all` costs one more parallel query per request rather than
one more sequential round trip per check.

**The two-step shape, and why the guard is deliberately loose.** The guard asks "do they hold
this permission, or lead _any_ ministry?" — it cannot ask about the target ministry, because at
guard time the request has not been read. Each handler then reads the ministry (which also
produces the 404 for one the caller cannot see) and calls `assertMinistryAuthority` with the
specific id. RLS refuses independently if both checks were somehow wrong.

**A failure here is loud, not silent:** the router throws at cold start if a route asks for the
leadership guard and the router was not given one.

---

## ADR-043 — A leader may not appoint a leader

**Status:** accepted · **Phase:** 7

Adding or promoting someone into `leader` or `assistant_leader` requires
`ministries.members.manage` at branch scope. A ministry leader may add, re-role, and end
ordinary memberships in their own ministry, but not create more leaders.

**Why:** leadership _is_ the authority. A leader who could appoint assistants could expand the
set of people able to edit their ministry, and could entrench themselves by appointing an ally
before their own membership ended. Restricting appointment to the branch permission keeps the
authority graph acyclic: leadership is granted from outside the ministry, never from within it.

**Consequence, accepted:** handing a ministry over needs an administrator. That is the correct
amount of friction for a change of authority, and it is one step, not a workflow.

---

## ADR-044 — Leaving a ministry sets a date; it does not delete the row

**Status:** accepted · **Phase:** 7

There is no `DELETE /api/ministries/:id/members/:memberId`. Ending a membership is
`PATCH { leftOn: '2026-08-31' }`, and reinstating is `PATCH { leftOn: null }`.

**Why:** past membership is what explains past attendance and past leadership. Deleting the row
would leave an attendance record whose subject was apparently never in the ministry. Every
"current membership" query filters `left_on is null`, and every uniqueness rule in the schema is
a partial index over the same condition — so a member can rejoin later without colliding with
their own history.

A `DELETE` on that path returns 405 with `Allow: PATCH`, which is asserted by a test so the
absence stays deliberate.

---

## ADR-045 — The register is written in one atomic batch

**Status:** accepted · **Phase:** 8

`POST /api/attendance/sessions/:id/records` accepts a single record, a bare array, or
`{ records: [...] }`, capped at 200. All of them become one `insert` with an array, which
PostgREST issues as a single statement.

**Why atomic:** a partially applied roll call is worse than a rejected one. If forty people are
submitted and one is already recorded, a per-row loop would leave the register in a state nobody
can reason about — an usher cannot tell which half took, and re-submitting double-records the
first half. All-or-nothing is explainable: fix the one row and send it again.

**Why 200:** enough for a whole service in one call, small enough that a runaway client cannot
post the entire roll. The three accepted shapes exist because the useful call is a batch while
the convenient call is one person, and normalising in the schema means one code path.

---

## ADR-046 — Leadership confers the register, not the session lifecycle

**Status:** accepted · **Phase:** 8

A ministry leader may open a session for their own ministry, write and correct its register, and
edit its headcounts. They may **not**:

- open a **service** session — that is the whole congregation, not one ministry
- **reopen** a closed session
- **delete** a session or a record

**Why the service exclusion:** a service register is the congregation's attendance. Letting a
ministry leader open one would give every leader authority over church-wide data, which is the
same over-reach ADR-020 was about.

**Why reopening is different from closing:** closing is a normal end-of-gathering act. Reopening
undoes the freeze that makes a register a record, so it needs `attendance.session.close`
specifically. The database trigger already enforces this and **does not accept leadership** —
the API mirrors it so the refusal names the permission instead of surfacing as a trigger error.

**Why deletion is excluded:** deleting a session discards everyone's attendance for that
gathering. That is not a decision about one ministry.

---

## ADR-047 — A member's attendance history is guarded by `members.view`, not `attendance.view`

**Status:** accepted · **Phase:** 8

`GET /api/members/:id/attendance` requires `members.view`.

**Why not the obvious permission:** decision D4 gives a member their own profile _and their own
attendance history_, and the RLS policy allows `member_id = app.current_member_id()`. A member
holds no `attendance.view` at all — guarding the route with it would refuse the very caller the
database is willing to serve, and the member-facing feature would be dead on arrival.

`members.view` is the permission a member does hold for their own record, and RLS narrows the
rows either way: a caller who may see the member sees their history, a caller who may not gets an
empty page rather than a leak. This is the second instance of the pattern from ADR-042 — an API
guard chosen to match what the database will actually allow, rather than the name that reads best.

---

## ADR-048 — A session cannot change what it is

**Status:** accepted · **Phase:** 8

`sessionUpdateSchema` omits `sessionType`, `ministryId`, `eventId`, and `branchId`. Title, date,
times, headcounts, notes, and status are editable.

**Why:** those four fields are what the attendance is _attributed to_. Changing
`ministry_id` after forty people are marked present silently moves their attendance to a
different ministry — and every report built on it. Correcting a genuine mistake means deleting
the session and opening the right one, which is visible and requires `attendance.delete`.

Editing the headcounts stays open because that is a correction to a count, not a
re-attribution — and the person counting is usually correcting themselves minutes later.

---

## ADR-049 — Publishing an event is a separate endpoint, not a status field

**Status:** accepted · **Phase:** 9

`status` is absent from `eventUpdateSchema`. The lifecycle lives at `POST /api/events/:id/status`,
and publishing there is gated on `events.publish` while every other transition is gated on
`events.update`.

**Why:** publishing is the moment an event becomes visible beyond the handful of people who can
already see drafts — it announces the event to the whole congregation. That is a different act
from correcting its venue or time. If `status` were an editable field, a `PATCH { status:
'published' }` would let anyone who holds `events.update` announce an event, collapsing two
permissions into one. Keeping publish on its own endpoint means the permission split in the seed
is the permission split in practice, and a publish shows up in the log as exactly that rather than
as a generic field edit.

**Cost, accepted:** two endpoints instead of one, and a `STATUS_RULES` table that names which
transitions are legal from where. That table is worth having anyway — it is where "an event
cannot go from completed back to draft" is written down.

---

## ADR-050 — A ministry leader may run their own event, but not announce, delete, or take registrations for it

**Status:** accepted · **Phase:** 9

The RLS policies and the API read `events.create`/`events.update` **OR** leading the event's
ministry. But `events.publish`, `events.delete`, and `events.attendance.manage` take the branch
permission outright — leadership does not confer them.

**Why:** this is ADR-020's rule applied to events — "OR leadership widens, it never narrows." A
choir leader should be able to create and shape the choir's concert without waiting on an
administrator. But three acts reach beyond the ministry:

- **Publishing** announces the event to the whole congregation (see ADR-049).
- **Deleting** takes the event and everyone's registrations with it; cancelling is the reversible
  option a leader _does_ have through the lifecycle.
- **Managing registrations** is recording who attended, which is congregation data of the same
  kind a service register holds (ADR-046).

Moving an event to a _different_ ministry is also excluded from the leader's authority: it changes
who may edit the event, so it needs the branch `events.update`. The API mirrors the RLS rather
than relying on it, so the refusal names the permission instead of surfacing as an empty result.

---

## ADR-051 — An event happens at an instant; a meeting happens at a wall-clock time

**Status:** accepted · **Phase:** 9

Event `starts_at`/`ends_at` are `timestamptz` and rendered in the reader's zone. A ministry's
recurring meeting time is a plain `time` and rendered exactly as stored.

**Why:** a harvest service at 09:00 on 4 October is a single moment — everyone reading about it,
in any zone, should be pointed at that same moment, so it is stored with an offset and converted
on display. A choir that rehearses "Thursdays at 18:00" means 18:00 local, every week, forever;
attaching a date or an offset to that would be wrong the first time the clocks change. Conflating
the two is a subtle bug — an event that appears an hour out — so the distinction is enforced by
the schema (two column types) and checked by a test that a bare local datetime is rejected in
favour of an explicit offset from the frontend.

---

## ADR-052 — Event capacity is a soft limit, and the check is allowed to race

**Status:** accepted · **Phase:** 9

Capacity is enforced by reading the current count and comparing before insert. Two simultaneous
registrations can both read 49 against a capacity of 50 and both succeed.

**Why:** closing the race means a trigger or a serialisable transaction on every registration, for
a failure mode whose worst outcome is one extra person at a church event — a chair, not a data
corruption. The cost is not worth paying at MVP. This is recorded as a known gap in
docs/SECURITY.md so it is a decision on the record, not an oversight, and can be revisited if an
event ever needs a hard cap (a ticketed conference, say).

---

## ADR-053 — The transaction currency is configured in settings and stamped server-side, never sent by the client

**Status:** accepted · **Phase:** 10

`finance.currency` is a global setting (seeded `GHS`, Q4c). The finance service reads it on each
write and stamps `currency` onto the row; the create and update schemas do **not** accept a
`currency` field. If the setting is unset, the write fails loudly with a 409 rather than defaulting.

**Why not a field on the form:** a ledger has one currency. Letting each transaction carry a
client-chosen currency produces a column of figures that cannot be summed, and no total in any
report would be trustworthy. Reading it from one place means every row agrees.

**Why it fails loudly rather than defaulting:** this is the whole reason the setting was seeded
NULL until Q4c was answered. A guessed default (USD, say) would produce a ledger that is quietly
wrong — every figure plausible, every figure in the wrong currency. A loud refusal is a bug report;
a wrong default is a silent corruption discovered at audit time.

**Why it is read per write rather than cached at module scope:** in a serverless environment a
module-scope cache would pin a stale currency until a cold start, so an administrator correcting it
would appear to have no effect. Writes are rare enough that one small read each is the right trade.

**Reaching the frontend.** The currency (and the church name) are `is_public` settings, loaded at
session establishment by `loadIdentity` and carried on the session payload as `settings`. This is
display only — never an authorization input — and RLS returns only `is_public` rows to a caller
without `settings.view`, so nothing privileged is exposed. It also gives the previously-hardcoded
church name a real home.

---

## ADR-054 — The transaction lifecycle is a separate endpoint, not a status field

**Status:** accepted · **Phase:** 10

`status` is absent from `transactionUpdateSchema`. The lifecycle lives at
`POST /api/transactions/:id/status`, and each transition is gated on its own permission —
`finance.submit`, `finance.approve`, `finance.reject`, `finance.void` — in a `STATUS_RULES` table.

**Why:** this is ADR-049 (the events publish split) applied to money. Recording and submitting a
transaction is a different act from approving it for the accounts, and they are different
permissions in the seed (D6: the Finance Officer records; the Senior Pastor approves). If `status`
were an editable field, a `PATCH { status: 'approved' }` would let anyone who may correct a draft
also approve it — collapsing the two-signature control into one. Keeping the lifecycle on its own
endpoint means the permission split in the seed is the permission split in practice, and an
approval reads as exactly that in the log rather than as a generic field edit.

The from-lists and the freeze on financial fields are enforced by the database trigger
(`app.guard_transaction_status`); the API mirrors them for a friendly message but is not the guard.

---

## ADR-055 — The second signature is enforced in the database and mirrored as a capability flag

**Status:** accepted · **Phase:** 10

Nobody may approve a transaction they submitted. This is enforced by the constraint
`transactions_no_self_approval` (approver ≠ submitter), and mirrored in the API two ways: a clean
403 on `POST /:id/status → approved` when `submitted_by` is the caller, and a `canApprove` flag on
the read that is false for the submitter, so the Approve button never renders for them.

**Why the constraint is the real guard:** a Super Administrator holds both `finance.submit` and
`finance.approve`. The permission split alone would not stop them approving their own entry — only
a rule that compares the two actors does. Putting it in a `check` constraint means it holds even if
the API layer has a bug, and even for the service-role key.

**Why mirror it in the API at all:** the constraint produces a database error, not a sentence a
treasurer can act on. The 403 says "you cannot approve a transaction you submitted; it needs a
second person", and the capability flag means the impossible action is never offered in the first
place. Three layers, each doing what it is best at: the button is hidden, the endpoint refuses
legibly, and the constraint makes it true.

---

## ADR-056 — Reports are capped aggregates over RLS-scoped rows, computed in the API

**Status:** accepted · **Phase:** 11

A report reads through the caller's own client — never the service-role key — so Row Level
Security scopes the rows before anything is summed. The aggregation itself is a pure reduction in
`src/lib/reports.js`; the service (`src/services/reports.service.js`) only does the read, capped at
`REPORT_ROW_CAP` (5,000) with an exact count. If the filtered window holds more than the cap, the
request is refused with a 409 that asks for a narrower range.

**Why cap-and-refuse rather than stream:** the phase's definition of done is "no report loads
unbounded rows". Streaming an open-ended result would put the function's memory and its time ceiling
at the mercy of the data, and truncating silently would make a total wrong — the worst outcome for a
figure someone trusts. Refusing is honest and, at congregation scale, effectively never hit within a
sensible date range.

**Why no aggregate SQL, RPC, or materialised view:** this phase adds no migration. PostgREST's own
aggregate functions are not guaranteed enabled on a Supabase project, and an RPC would be a second
place authorization lives. A reduction over a capped, RLS-scoped read needs none of that and is
trivially unit-tested against fixture rows — which is where the arithmetic (including that money
does not drift) is proven, without a database.

**Why the aggregate inherits the boundary:** because every read is the caller's own, a report can
never show a figure the caller could not have reached one row at a time. The summary of a branch
they cannot see is simply empty, decided by the same policy as the detail.

---

## ADR-057 — Report visualisation is `<meter>` and CSS, not a charting library

**Status:** accepted · **Phase:** 11

The blueprint deferred Chart.js to "your call at Phase 11". The call is: no dependency. Proportion
bars are `<meter value max>` elements and headline numbers are styled `<div>`s.

**Why:** the strict CSP (ADR-006) blocks inline `style="width:62%"`, which is how a hand-built bar
would set its length — so a charting approach would either need a canvas library vendored and
CSP-reviewed, or programmatic style that fights the very rule that keeps the app XSS-resistant. A
`<meter>` gives a proportion bar from attributes alone, is natively accessible (it announces its
value without any ARIA of ours), and costs nothing. For the numbers a congregation's reports show,
it is the right amount of chart.

---

## ADR-058 — Report CSV is a capped, server-built download gated on the report's own permission

**Status:** accepted · **Phase:** 11

Each report has an `/export` endpoint returning `text/csv` as an attachment (`fileResponse` in
`src/lib/http.js`, which keeps every security header and only swaps the content type). It is capped
exactly as the summary is, and gated on the **report-view** permission — not the separate
`finance.export` / `members.export` permissions.

**Why the report-view permission, not `*.export`:** the CSV is the very rows the caller can already
see rendered on the report page. The `*.export` permissions govern exporting the _operational_ lists
— the raw ledger, the full member roll — which is a different surface. A report a role may read, it
may also download.

**Why the CSV neutralises formulas:** a field beginning `=`, `+`, `-`, or `@` is treated as a
formula by Excel and Sheets, so a member name like `=HYPERLINK(...)` would be a stored payload that
runs when a treasurer opens the export. `src/lib/csv.js` prefixes such a field with a single quote
(OWASP's CSV-injection mitigation) — the value reads unchanged, but the spreadsheet treats it as
text. This matters precisely because every report is a file a human downloads and opens.

**Why a fetch-to-blob download rather than a plain link:** the button fetches with credentials and,
on a 409 "narrow your filters", shows the message inline — so a failed export never silently saves a
file full of error JSON.

---

## ADR-059 — Audit writing is best-effort; the actor comes from the JWT; the trail is append-only

**Status:** accepted · **Phase:** 12

Mutations call `audit.record(context, …)`, which writes one row through the `app.log_audit`
`SECURITY DEFINER` function. Three properties are deliberate:

**Best-effort, never fatal.** A failed audit write is caught and logged as a warning; it does not
turn a member edit that already succeeded into a 500. The database — its constraints and RLS — is
the source of truth for the record itself; the audit log is a supplementary trail, and losing one
entry to a transient error is a smaller harm than rolling back a legitimate change or surfacing a
scary error for something that worked. (If a future control needs a _guaranteed_ audit — say, for
finance approvals — it should be a trigger on the table, not application code.)

**The actor is taken from the JWT inside the function, never passed by the caller**, so a client
cannot forge who did a thing. The function also redacts any credential-looking key from the
`changes` payload as a backstop.

**Append-only in the strongest sense.** No UPDATE or DELETE policy exists on `audit_logs`, and
triggers refuse both for every role including the table owner and the service-role key — so history
cannot be quietly rewritten even from the database side. The API exposes only a read endpoint.

**What it records:** field _names_, not values — a member update logs `{ fields: [...] }`, never the
new phone number, so the trail is not a second copy of everyone's PII. Wired into the mutation paths
of every feature module: members, emergency contacts, families, ministries, attendance, events, and
transactions.

---

## ADR-060 — Emergency contacts are guarded through their member, with no permission of their own

**Status:** accepted · **Phase:** 12

The `member_emergency_contacts` endpoints are gated on `members.view` (read) and `members.update`
(write) — the member's own permissions — and RLS narrows both to the specific member through
`app.can_view_member` / `app.can_edit_member`. There is no `emergency_contacts.*` permission.

**Why:** an emergency contact is not an independently-owned resource; it exists only as part of a
member's record, and anyone who may edit the member should be able to maintain their contacts.
Inventing a separate permission would be a knob nobody wants to set differently, and it would risk
the two drifting out of step. The table carries no `branch_id` for the same reason — its branch _is_
its member's branch, and the policy reads it from there. Every query is still scoped by `member_id`
(and the row id) so a contact cannot be reached through another member's path.

---

## ADR-061 — The photo upload is brokered through signed URLs; the file never crosses the API

**Status:** accepted · **Phase:** 12

Uploading a member photo is a three-step handshake: the API mints a signed **upload** URL, the
browser PUTs the bytes straight to Supabase Storage, then the API records the resulting path. Reads
are short-lived signed URLs, minted only for a caller who may see the member.

**Why not proxy the file through the API:** the function body cap is 128 KB (ADR — `MAX_BODY_BYTES`),
far below a 2 MB photo, and base64-in-JSON would bloat it further. More fundamentally, the browser
holds no Supabase key, so the API has to broker _something_ — and brokering a short-lived URL keeps
the bytes off our compute entirely while still gating who may upload (the signed URL is minted
through the caller's own client, so Storage's RLS, keyed on the branch in the path, is the real
guard).

**Why the confirm step validates the path prefix:** `PATCH …/photo { path }` refuses any path not
under `{branch_id}/{member_id}/`, so a caller cannot point a member's `photo_path` at another
member's object and read it later through the signer. The path is part of the access decision, not
cosmetic.

**Honest limit:** Supabase Storage's own MIME/size enforcement and the exact signed-URL wire format
have not been run against a real project here — they are tested against a shim that records the
calls. Recorded as a known gap in docs/SECURITY.md.

---

## ADR-062 — Spiritual gifts are a controlled lookup, and its two operations are two permissions

**Status:** accepted · **Phase:** 12 · _implements decision D7_

Which gifts a church recognises is a shared lookup (`spiritual_gifts`), and a member's gifts are a
join to it (`member_spiritual_gifts`) — not free text. Two operations, deliberately gated
differently:

- **Editing the lookup** — adding, renaming, or retiring a gift — needs `settings.manage`, because
  it is church policy that applies to everyone, the same shape as a setting. There is no delete: a
  gift is retired by clearing `is_active`, and the join's foreign key is `ON DELETE RESTRICT`, so a
  gift already recorded against members cannot vanish.
- **Attaching a gift to a member** needs `members.update`, because it is part of editing that
  member's record; RLS narrows it to the specific member through `app.can_edit_member`.

**Why a lookup rather than free text (D7):** gift-based reporting only works if the values are
controlled — free text produces "Teaching", "teacher", "Teachng" and no report can group them. The
cost is that adding a new recognised gift is an administrative act, which is the right friction.

**Now built:** the lookup-management screen lives on the settings admin page (ADR-063), under the
same `settings.manage` permission; the member panel consumes the same lookup.

---

## ADR-063 — The settings admin edits values only, gates read and write alike, and stamps the actor server-side

**Status:** accepted · **Phase:** 12

The in-app settings admin (`GET /api/admin/settings`, `PATCH /api/admin/settings/:key`) is the home
for church-wide configuration — the finance currency, the church name — with the spiritual-gifts
lookup edited beside it (ADR-062). Three choices worth recording:

- **One permission gates both reading the list and writing a value: `settings.manage`.** The editing
  screen belongs to whoever may _change_ a setting, not merely see one. `settings.view` exists — it is
  the RLS read grant that lets the session surface public settings and that other reads rely on — but
  it is deliberately not a key to this page. Gating the list on `settings.view` would have locked the
  real administrator, who holds `manage` and not `view`, out of the screen they own.

- **Only `value` is editable, and the actor is stamped from the session.** A setting's key and meaning
  are fixed metadata, changed by a migration rather than a form, so the update schema accepts `value`
  and nothing else (`.strict()`) — a client cannot smuggle a `scope`, a `key`, or an `updated_by`.
  `updated_by` is written from `context.session.userId`; the `settings_touch_updated_at` trigger
  maintains `updated_at` but not the actor, so the API stamps it.

- **The editor picks its control from the value's type.** A boolean is a Yes/No select, a number a
  number field, a string a text box; an object or array has no MVP editor and is shown read-only, so a
  structured setting cannot be flattened into a string. `value` is `jsonb`, so any JSON value is valid:
  the schema does not constrain its shape and there is no per-key check constraint to trip — which is
  why, unlike every other write path, no settings entry was added to the constraint-message map.

**The read channel is separate.** Public settings (`is_public`) reach the frontend through the session
payload as `{ churchName, currency }`, not through this page (ADR-053); this page is the write path,
and its controls are a convenience over an API that RLS guards regardless.

---

## ADR-064 — User administration deactivates rather than deletes, mirrors the database guards, and refuses self-service early

**Status:** accepted · **Phase:** 13

The user-administration surface (`/api/admin/users`) invites accounts, edits profiles, toggles
activation, and grants or revokes role grants. It is where an administrator manages who may use the
system and what they may do. Several choices worth recording:

- **There is no delete — an account is deactivated.** The routes expose no `DELETE /admin/users/:id`,
  and `profiles` has no delete RLS policy to back one. An account accumulates history — it is the
  `created_by`, `updated_by`, `granted_by`, and actor on audit rows across the whole schema — so
  removing it would either cascade through that history or strand it. Deactivation (`is_active = false`)
  refuses sign-in at the API layer (`loadIdentity`) and is the reversible, history-preserving answer.

- **Every guard in the route layer is a mirror; the database is the authority.** RLS on `profiles`,
  `roles`, and `user_roles`, plus the escalation triggers — `profiles_guard_update` (changing
  `is_active` needs `users.deactivate`), and the `user_roles_guard_*` triggers (no self-grant, no
  handing out authority you do not hold, never remove the last active Super Administrator) — enforce
  the rules regardless of what the API does. The API refusals exist to turn a non-bypassable trigger's
  generic `insufficient_privilege` (a bare 403) into a legible, before-the-round-trip message.

- **Self-service is refused early, on purpose.** A user cannot change their own activation or their own
  role grants: the handlers check `context.params.id === context.session.userId` and throw `forbidden`
  before the query runs. This is not the guard — the trigger refuses it too — but it says _what_
  happened ("You cannot change your own account activation") instead of leaking a generic privilege
  error. The capability flags the read endpoint returns (`canDeactivate`, `canManageRoles`) are
  computed with the same `!isSelf` condition, so the frontend never even offers the control.

- **Provisioning is the one path that legitimately bypasses RLS.** There is no `auth.users` trigger
  that creates a profile and no INSERT policy on `profiles`, so a new account must be made in two
  steps only the service-role client can perform: create the auth user (`inviteUserByEmail`), then
  insert the profile. The two must succeed together, so a failed profile insert rolls back the
  orphaned auth user — a half-made account never lingers. This is the only caller of the admin client
  in the feature; everything else runs on the user client under RLS.

- **`granted_by` is stamped from the session, never the client.** A role grant records who issued it
  from `context.session.userId`, so the row cannot claim someone else authorised it — the same
  server-stamps-the-actor rule as ADR-063's `updated_by`.

- **Five separate permissions, not one admin flag.** `users.view`, `users.invite`, `users.update`,
  `users.deactivate`, and `users.roles.manage` are distinct and global (branch id null in the seed),
  so viewing the roster, inviting, editing a profile, switching an account off, and handing out roles
  are five decisions a role can hold in any combination. `users.view` alone opens the list and the
  role catalogue read-only; the others each gate exactly their own write.

**Deferred:** an invited user follows the emailed link to the existing reset-password page to set an
initial password; a dedicated invite-acceptance page is deferred. Recorded so the reuse stays a
decision rather than a surprise.

---

## ADR-065 — Role administration is full CRUD under one global permission, with an API-only escalation guard, immutable keys, and protected system roles

**Status:** accepted · **Phase:** 13

The role-administration surface (`/api/admin/roles`) is where the permission model itself is
edited: create a custom role, change any role's name, description, sort order, or permission set,
and delete an unused custom role. It is distinct from user administration's `users.roles.manage`
(ADR-064), which assigns an existing role _to a person_ — this manages the `roles` and
`role_permissions` tables themselves. No migration or seed was needed: the tables, the
`roles.manage` permission (seeded global, branch id null), the RLS policies, and the
`roles_protect_system*` triggers all already existed. Several choices worth recording:

- **One global permission gates the whole surface: `roles.manage`.** All seven routes declare it,
  and because it is seeded with a null branch the unscoped `context.can('roles.manage')` is the
  right question — there is no branch-scoped or ministry-leadership path here, unlike the feature
  modules. It is a different capability from `users.roles.manage`: one shapes what a role _is_, the
  other hands that role to someone.

- **Every guard is a mirror; the database is the authority.** RLS on `roles`, `permissions`, and
  `role_permissions`, plus the `roles_protect_system` (no deleting a system role) and
  `roles_protect_system_update` (no clearing `is_system`, no changing a system role's `key`)
  triggers, enforce the rules regardless of the API. The handlers run on the user client under RLS;
  none of them touches the service-role client.

- **Two protections live only in the API, because the database does not provide them.** First, a
  role still granted to anyone cannot be deleted: `user_roles.role_id` is `on delete restrict`, so
  the delete would trip a foreign-key violation that maps to a misleading "linked records" message —
  the handler pre-checks the grant count and refuses with a written sentence instead. Second, the
  **escalation guard**: when a permission is _added_ to a role, the acting admin must themselves hold
  it. The database gates `role_permissions` on `roles.manage` alone and does not check this, so
  without the guard a delegated role manager could grant a role authority they lack and then take
  that role. It is a no-op today — only `super_admin` holds `roles.manage`, and it holds everything —
  but it closes the escalation the moment `roles.manage` is delegated. Removals are always allowed,
  and the refusal message names the permission, mirroring the shape of the `user_roles` "no handing
  out authority you do not hold" trigger.

- **A role's `key` is immutable after creation, and `is_system` is never client input.** The update
  schema omits `key` entirely (`.strict()`), so the key is asked for once on the create form and
  never again. This keeps the schema simple and makes the system-role-key-change trigger unreachable
  through the API. `is_system` is set only by the seed's default (false) — the create schema does not
  accept it — so no request can mint a system role or promote a custom one.

- **Permissions are replaced as a set, diffed server-side, and audited as keys.** `PUT
/admin/roles/:id/permissions` takes the whole desired set; the handler reads the role's current
  ids, computes the add/remove diff, runs the escalation guard over the additions, and writes only
  the difference. The audit row records permission _keys_ (`{ added: [...], removed: [...] }`), never
  ids — legible and consistent with the field-names-not-values audit rule (ADR-059).

**System roles are editable but never deletable.** Their name, description, sort order, and
permission set can all be changed (an administrator tuning the seeded model is expected); only
deletion and the `key`/`is_system` columns are locked, and the database triggers are the backstop
behind the API's plain-language refusals.

## ADR-066 — Notifications are in-app only, fanned out to recipients at publish time, under two global permissions

**Status:** accepted · **Phase:** 13

The notifications surface is the last in-scope MVP feature (BLUEPRINT §11): an inbox every role
reads with an unread badge, and a publisher console (`/api/admin/notifications`) where an
announcement is composed and sent to an audience. As with roles, no migration or seed was needed —
the `notifications` and `notification_recipients` tables, the `notification_type` / `severity` /
`audience` enums, the RLS policies, and the two permissions (`notifications.view`,
`notifications.create`, both seeded global, branch id null) all already existed. Several choices
worth recording:

- **Two global permissions, split by direction: `notifications.view` reads the inbox,
  `notifications.create` publishes.** Both are seeded with a null branch, so the unscoped
  `context.can(...)` is the right question and every one of the nine routes is gated directly —
  there is no branch-scoped or leadership path. `notifications.view` is held by nearly every role;
  `notifications.create` by the senior pastor and secretary.

- **Every guard is a mirror; the database is the authority.** `notifications_select` shows a user a
  row only through a `notification_recipients` row (or `notifications.create` for a publisher);
  `notifications_write` and `notification_recipients_insert` gate publishing on
  `notifications.create`; `notification_recipients_update_own` scopes a read-marking to the caller.
  The handlers run on the user client under RLS; none touches the service-role client.

- **Delivery is fan-out at publish time, resolved API-side under the same user client.** A normal
  user sees a notification only via a `notification_recipients` row, so publishing must materialise
  one row per recipient. Both publishers hold `users.view`, and `profiles_select_managed` /
  `user_roles_select_managed` grant the reads the fan-out needs, so the audience is resolved with
  plain `profiles` / `user_roles` queries — no SECURITY DEFINER function, keeping this consistent
  with the roles "no schema changes" rule. Publishing to a role or branch that matches nobody still
  creates the notification (recipient count 0); the publisher can see it via `notifications_select`.

- **The audience is everyone, a role, or a branch — never a single user.** The schema has no
  target-user column (`audience` is `all` | `role` | `branch` | `user`, but `user` has no address
  field), and a single-recipient direct message reads more like messaging than an announcement, so
  it is out of scope. The `user` audience and the `event_reminder` type are both refused by the Zod
  enum: event reminders are reserved for a future automated path, never hand-composed here.

- **Audience coherence is mirrored in validation, and `created_by` is stamped server-side.** The
  `notifications_audience_role` CHECK requires `audience_role_id` set if and only if the audience is
  a role; the create schema's `.superRefine` enforces the same (plus the branch equivalent) so a
  mistake is a field-attributed 422 before the round trip. `.strict()` rejects any unknown key, and
  `created_by` is taken from the session, never the client — a request cannot forge the author.

- **Reads and read-markings are not audited; only publish and retract are.** Marking an inbox item
  read is per-user and high-volume, with no security value; publishing (`notification.published`,
  recording type/severity/audience/recipient count) and retraction (`notification.deleted`) are the
  consequential acts and are the only ones written to the trail (ADR-059). Retraction deletes the
  notification; its `notification_recipients` cascade, so it vanishes from every inbox at once.

- **Expiry is a query-time filter, not a sweeper.** The inbox query filters
  `expires_at.is.null,expires_at.gt.<now>`; an expired notification simply stops appearing. There is
  no background job, and the unread badge is read fresh on every page load through the shell, so no
  polling or client cache can drift.
