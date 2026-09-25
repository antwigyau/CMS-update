# Church Management System

A secure, modern church management system built on **Vercel** (static frontend + one
serverless API function) and **Supabase** (PostgreSQL, Auth, Storage).

> **Build status: Phases 1–10 of 14 complete (Foundation → Finance).**
> The architecture, API layer, design system, the full database schema — 25 tables with Row
> Level Security — the authentication layer, and the Members, Families, Ministries, Attendance,
> Events, and Finance modules are in place and tested. Sign-in works against
> a fake provider in the test suite; it has **not** yet run against a real Supabase project.
> See [Build status](#build-status) for exactly what does and does not work.
>
> Architecture and open questions: [BLUEPRINT.md](BLUEPRINT.md).
> Schema: [docs/DATABASE.md](docs/DATABASE.md).
> Security posture and known gaps: [docs/SECURITY.md](docs/SECURITY.md).
> Deployment procedure: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
> Decisions and their reasons: [docs/DECISIONS.md](docs/DECISIONS.md).

---

## Architecture in one picture

```
Browser  (HTML5 / CSS3 / ES modules / Bootstrap 5)
   │  fetch() — same-origin only, HttpOnly session cookies
   ▼
Vercel Edge Network
   ├── /            → static files from public/   (no compute)
   └── /api/*       → api/index.js  (one Node.js 24 function: the BFF)
                          │  session → CSRF → permission → validation → handler
                          ▼
                     Supabase  (PostgreSQL + RLS · Auth · Storage)
```

**The browser holds no Supabase credentials and never contacts Supabase directly.** Every
request passes through the API layer, which authorises it and then queries Supabase _as the
signed-in user_, so Row Level Security applies underneath as a second, independent check.

---

## Prerequisites

| Requirement        | Why                                                                     | Status on this machine (checked 2026-08-28) |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------------- |
| Node.js 24.x       | Matches Vercel's default runtime                                        | ✅ v24.16.0                                 |
| npm 11             |                                                                         | ✅ v11.13.0                                 |
| Supabase CLI       | Migrations, local stack                                                 | ✅ v2.115.0 (a devDependency)               |
| **Git**            | Version control (§32 of the spec)                                       | ❌ **not installed**                        |
| **Docker Desktop** | `supabase start` — running the schema against real Supabase, not a shim | ❌ **not installed**                        |
| Vercel CLI         | Optional — `npm run dev` covers local development                       | not installed                               |

The database suite runs **without** Docker (see [The database](#the-database)), so Phase 2 is
tested. Docker is what lets the schema be verified against real Supabase rather than shims.

Install Git (Windows):

```powershell
winget install --id Git.Git -e --source winget
```

Install Docker Desktop: https://www.docker.com/products/docker-desktop/

---

## Getting started

```powershell
# 1. install dependencies
npm install

# 2. copy the vendored Bootstrap assets into public/assets/vendor/
npm run vendor:refresh

# 3. (optional now, required from Phase 3) configure Supabase
Copy-Item .env.example .env.local
#   then fill in SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

# 4. run it
npm run dev
```

Then open:

| URL                                 | What it is                                                        |
| ----------------------------------- | ----------------------------------------------------------------- |
| http://localhost:3000/              | Sign-in page                                                      |
| http://localhost:3000/dashboard     | The first protected page — redirects to sign-in without a session |
| http://localhost:3000/design-system | Design system reference and a live API smoke test                 |
| http://localhost:3000/api/health    | Liveness probe, public                                            |

Without a Supabase project configured, `/api/health` reports
`supabase.configured: false` and a sign-in attempt returns a configuration error. That is the
honest behaviour: authentication needs a real GoTrue, and nothing pretends otherwise. To sign
in locally, fill in `.env.local` and follow
[docs/DEPLOYMENT.md § Bootstrap the first administrator](docs/DEPLOYMENT.md).

### Scripts

| Command                           | What it does                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run dev`                     | Local server on :3000, serving `public/` and routing `/api/*` into the real handler |
| `npm test`                        | Everything: unit tests plus the database suite                                      |
| `npm run test:unit`               | Unit tests only (`node:test`, no test framework dependency)                         |
| `npm run test:db`                 | Applies every migration to an in-process PostgreSQL and tests the schema and RLS    |
| `npm run lint`                    | ESLint, including the two security rules described below                            |
| `npm run format` / `format:check` | Prettier                                                                            |
| `npm run vendor:refresh`          | Re-copies Bootstrap from `node_modules` into `public/assets/vendor/`                |
| `npm run check`                   | lint + format check + tests — run this before every commit                          |
| `npm run db:start` / `db:stop`    | The local Supabase stack (needs Docker Desktop)                                     |
| `npm run db:reset`                | Rebuild the schema from migrations, then seed                                       |
| `npm run db:push`                 | Apply migrations to a linked Supabase project                                       |
| `npm run db:stats`                | Print table, policy, index, and constraint counts                                   |

---

## The database

25 tables, Row Level Security on every one, 13 forward-only migrations, and idempotent seed
data containing no personal information. Full documentation:
**[docs/DATABASE.md](docs/DATABASE.md)**.

The parts worth knowing before reading the SQL:

- **Authorization is data.** `user → user_roles → roles → role_permissions → permissions`. No
  role name appears in a policy or in application code; everything asks
  `app.has_permission_in('members.create', branch_id)`.
- **A ministry leader's authority is row-level, not a branch grant.** Leaders hold only read
  permissions branch-wide; managing their ministry comes from computed leadership scope. A
  failing test found this the hard way — see ADR-020.
- **The directory is a separate permission.** `members.view_directory` exposes five columns
  through a function, so an usher can find a name and a face without getting home addresses.
- **Finance is enforced in the database.** Submit → approve, with a constraint that the
  approver cannot be the submitter, financial fields frozen after submission, no DELETE for
  anyone, and no default currency to guess wrong with.
- **The audit log is physically append-only.** No UPDATE or DELETE policy, plus triggers that
  raise for every role including the table owner.

`npm run test:db` proves all of this without Docker, by applying the migrations to PGlite —
PostgreSQL compiled to WebAssembly — with Supabase's own default grants in place so RLS is
load-bearing in the test. What that does _not_ cover is listed in `tests/db/shims.sql` and
needs `supabase start`.

---

## Project structure

```
api/index.js         the only serverless function; adapts Vercel to src/server/app.js
public/              static frontend, served by the CDN with no compute
  assets/css/        tokens.css (design tokens) + app.css (components)
  assets/js/core/    api client, session, dom helpers, theme, toast, shell
  assets/js/pages/   one module per page
  assets/vendor/     Bootstrap, generated by vendor:refresh (gitignored)
  dashboard/ forgot-password/ reset-password/ design-system/
src/                 server-side only — never reaches the browser
  auth/              cookies, CSRF, the GoTrue boundary, session resolution, identity
  config/env.js      fail-fast environment validation
  data/              Supabase clients: user-scoped (default) and admin (restricted)
  lib/               errors, logger, http envelopes, security headers, version
  server/            router, app entrypoint, middleware, route modules
  validation/        zod schemas and the 422 mapper
supabase/
  migrations/        13 forward-only SQL migrations
  seed.sql           roles, permissions, and reference lists — no personal data
  config.toml        Supabase CLI configuration
scripts/             dev-server.mjs, vendor-refresh.mjs, db-stats.mjs
tests/unit/          unit and API-level tests, including the fake auth provider
tests/db/            schema, constraint, RLS, and finance-workflow tests
docs/                DATABASE.md, SECURITY.md, DEPLOYMENT.md, DECISIONS.md
BLUEPRINT.md         the approved architecture and the open questions
```

---

## Authentication

Sign-in, sign-out, session refresh, and password reset. The design decisions worth
knowing before reading the code:

- **The browser never holds a token.** Tokens live in `HttpOnly` cookies; the API returns the
  user and a list of permission keys, and a test asserts no token-shaped string appears in the
  response body. The refresh cookie is scoped to `Path=/api/auth`, so it is not even
  transmitted on ordinary API calls.
- **Refreshing happens on exactly one endpoint.** GoTrue rotates refresh tokens, so concurrent
  refreshes would invalidate each other and sign the user out. `GET /api/auth/session` is the
  only route that refreshes; ordinary routes return 401 and the client retries once (ADR-022).
- **Permissions are read from the database on every request**, not cached in the JWT, so a
  revoked role takes effect immediately. Tested (ADR-023).
- **Deactivation removes database access**, not just the session — checked by the identity
  loader and again by every RLS helper.
- **The login endpoint has a 300 ms floor** and gives byte-identical answers for a wrong
  password and an unknown address, so it cannot be used to discover who is a member (ADR-026).
- **CSRF** is a double-submit token plus a `Sec-Fetch-Site`/`Origin` check, enforced by the
  session guard itself so a future route cannot forget it (ADR-024, ADR-025).

The GoTrue boundary is one small module, injected rather than imported. The test suite
substitutes a fake for it and drives everything else — cookies, CSRF, rate limiting, the
session resolver, the guards, validation, and error mapping — through real HTTP requests. What
that leaves unverified is the Supabase round trip itself, which needs a real project.

---

## Members

The first feature module, and the one that proves the authorization model end to end: it
touches the API guards, RLS, the branch-scoped permission check, and the restricted directory.

| Endpoint                        | Permission               | Notes                                      |
| ------------------------------- | ------------------------ | ------------------------------------------ |
| `GET /api/members`              | `members.view`           | search, status filter, sort, paginate      |
| `GET /api/members/directory`    | `members.view_directory` | five columns only, via a database function |
| `POST /api/members`             | `members.create`         | checked against the **target branch**      |
| `GET /api/members/:id`          | `members.view`           | 404 when RLS hides the row                 |
| `PATCH /api/members/:id`        | `members.update`         | only the fields supplied                   |
| `DELETE /api/members/:id`       | `members.delete`         | soft delete                                |
| `POST /api/members/:id/restore` | `members.delete`         |                                            |

Emergency contacts hang off a member (guarded through it, no separate permission — ADR-060), and
the photo is brokered through signed Storage URLs so the file never crosses the API (ADR-061):

| Endpoint                                       | Permission             | Notes                            |
| ---------------------------------------------- | ---------------------- | -------------------------------- |
| `GET/POST /api/members/:id/emergency-contacts` | view / update          | list; add                        |
| `PATCH/DELETE …/emergency-contacts/:contactId` | `members.update`       | edit; remove                     |
| `GET /api/members/:id/photo`                   | `members.view`         | short-lived signed read URL      |
| `POST /api/members/:id/photo/upload-url`       | `members.photo.manage` | signed upload URL + the path     |
| `PATCH /api/members/:id/photo`                 | `members.photo.manage` | confirm the uploaded path        |
| `DELETE /api/members/:id/photo`                | `members.photo.manage` | remove object and clear the path |

Spiritual gifts (decision D7) are a controlled lookup, not free text — editing the list is a
settings task, attaching one to a member is editing the member (ADR-062):

| Endpoint                                    | Permission        | Notes                        |
| ------------------------------------------- | ----------------- | ---------------------------- |
| `GET /api/spiritual-gifts`                  | `members.view`    | the shared list (`?all=1`)   |
| `POST/PATCH /api/spiritual-gifts[/:id]`     | `settings.manage` | add / edit / retire a gift   |
| `GET/POST /api/members/:id/spiritual-gifts` | view / update     | a member's gifts; attach one |
| `DELETE …/spiritual-gifts/:giftId`          | `members.update`  | detach a gift                |

Worth knowing:

- **Search, filters, sort, and paging are server-side** and reflected in the URL, so a filtered
  list is a shareable link and the back button works. Nothing is filtered in the browser — the
  members table has a GIN index for exactly this (§26).
- **The page size is capped at 100 server-side.** `?pageSize=100000` returns 100 (ADR-031).
- **Sort keys are an allow-list**, so no column name from a client reaches the query builder
  (ADR-032).
- **A row hidden by RLS is a 404, not a 403** — a 403 would confirm the id is real (ADR-035).
- **Constraint names never appear in error messages.** A duplicate email becomes a 409 with a
  field-level message; `members_branch_email_key` stays in the log (ADR-034).
- **The branch check happens where the branch is known.** On create it comes from the payload,
  so the API can refuse cleanly; on update and delete the row's branch is known only to the
  database, so RLS and the field-level triggers are what enforce it.

---

## Families

Households, so an address and a phone number live in one place rather than being copied onto
every member of a family.

| Endpoint                                     | Permission        |
| -------------------------------------------- | ----------------- |
| `GET /api/families`                          | `families.view`   |
| `POST /api/families`                         | `families.create` |
| `GET /api/families/:id`                      | `families.view`   |
| `PATCH /api/families/:id`                    | `families.update` |
| `DELETE /api/families/:id`                   | `families.delete` |
| `POST /api/families/:id/members`             | `families.update` |
| `PATCH /api/families/:id/members/:memberId`  | `families.update` |
| `DELETE /api/families/:id/members/:memberId` | `families.update` |

Worth knowing:

- **Two rules are enforced by the database**: at most one head per household, and a member
  belongs to at most one household. Both surface as field-level messages rather than as
  constraint names (ADR-034).
- **Deleting a household deletes the grouping, not the people.** Members are soft-deleted;
  households are not, because a household holds no information about anybody on its own
  (ADR-037).
- **There is no `head_member_id` column.** The head is the membership row whose relationship is
  `head`, so the two cannot disagree (ADR-038).
- **The branch of a membership row is read from the household**, never from the request — which
  is what makes the composite foreign keys a real guarantee (ADR-040).
- **Adding a member uses the restricted directory**, so the picker works for someone holding
  `members.view_directory` without `members.view`.

---

## Ministries

Where the authorization model earns its keep. A ministry leader holds **no** branch-wide write
permission — their authority over their own ministry is computed from `ministry_members`.

| Endpoint                                      | Permission                  | Leader also admitted |
| --------------------------------------------- | --------------------------- | -------------------- |
| `GET /api/ministries`                         | `ministries.view`           | —                    |
| `POST /api/ministries`                        | `ministries.create`         | no                   |
| `GET /api/ministries/:id`                     | `ministries.view`           | —                    |
| `PATCH /api/ministries/:id`                   | `ministries.update`         | **yes, own only**    |
| `DELETE /api/ministries/:id`                  | `ministries.delete`         | no                   |
| `POST /api/ministries/:id/members`            | `ministries.members.manage` | **yes, own only**    |
| `PATCH /api/ministries/:id/members/:memberId` | `ministries.members.manage` | **yes, own only**    |

Worth knowing:

- **The API had to learn about leadership.** `requirePermission` would have refused a leader
  before RLS ever saw the request, making the role useless — and the Phase 2 RLS tests would
  still have passed, because they bypass the API. The router now has a second guard kind, and
  `session.ledMinistryIds` carries the computed authority (ADR-042).
- **A leader may not appoint a leader.** Adding or promoting into `leader` or
  `assistant_leader` needs the branch permission, so leadership is always granted from outside
  the ministry rather than from within it (ADR-043).
- **Leaving sets a date; it does not delete the row.** `DELETE` on a membership returns 405 —
  past membership is what explains past attendance (ADR-044).
- **One active leader per ministry**, enforced by partial unique index; a second attempt is a
  409 with a field-level message.

---

## Attendance

Decision D5 made concrete: **named records and aggregate headcounts side by side, never
reconciled.** A report reads "212 counted, 148 identified" — both true, because nobody
identifies 200 people at a door.

| Endpoint                                                | Permission                  | Leader also admitted |
| ------------------------------------------------------- | --------------------------- | -------------------- |
| `GET /api/attendance/sessions`                          | `attendance.view`           | —                    |
| `POST /api/attendance/sessions`                         | `attendance.session.create` | **ministry only**    |
| `GET /api/attendance/sessions/:id`                      | `attendance.view`           | —                    |
| `PATCH /api/attendance/sessions/:id`                    | `attendance.session.create` | **yes, own only**    |
| `DELETE /api/attendance/sessions/:id`                   | `attendance.delete`         | no                   |
| `POST /api/attendance/sessions/:id/records`             | `attendance.record`         | **yes, own only**    |
| `PATCH /api/attendance/sessions/:id/records/:recordId`  | `attendance.update`         | **yes, own only**    |
| `DELETE /api/attendance/sessions/:id/records/:recordId` | `attendance.delete`         | no                   |
| `GET /api/members/:id/attendance`                       | `members.view`              | —                    |

Worth knowing:

- **Closing a session freezes its register**, enforced by a database trigger. Reopening needs
  `attendance.session.close` and leadership does **not** lift it — the API says so plainly rather
  than letting the trigger produce the refusal (ADR-046).
- **The register is written atomically.** One request, one `insert`, all-or-nothing: a partially
  applied roll call is worse than a rejected one, because nobody can tell which half took
  (ADR-045).
- **A leader may open a ministry session but not a service one** — a service register is the
  congregation's attendance, not one ministry's.
- **A session cannot change what it is.** `sessionType`, `ministryId`, `eventId`, and `branchId`
  are not editable: changing them would silently re-attribute everyone's attendance (ADR-048).
- **A member's own history is guarded by `members.view`**, not `attendance.view` — a member holds
  the former for their own record and none of the latter (ADR-047).

---

## Events

An event moves through a lifecycle — **draft → published → ongoing → completed**, with
**cancelled** reachable from any live state — and the calendar shows what is public.

| Endpoint                                               | Permission                 | Leader also admitted    |
| ------------------------------------------------------ | -------------------------- | ----------------------- |
| `GET /api/event-categories`                            | `events.view`              | —                       |
| `GET /api/events`                                      | `events.view`              | —                       |
| `POST /api/events`                                     | `events.create`            | **ministry only**       |
| `GET /api/events/:id`                                  | `events.view`              | —                       |
| `PATCH /api/events/:id`                                | `events.update`            | **yes, own only**       |
| `POST /api/events/:id/status`                          | `events.update`            | **yes, except publish** |
| `DELETE /api/events/:id`                               | `events.delete`            | no                      |
| `GET /api/events/:id/registrations`                    | `events.view`              | —                       |
| `POST /api/events/:id/registrations`                   | `events.attendance.manage` | no                      |
| `PATCH /api/events/:id/registrations/:registrationId`  | `events.attendance.manage` | no                      |
| `DELETE /api/events/:id/registrations/:registrationId` | `events.attendance.manage` | no                      |

Worth knowing:

- **Publishing is its own endpoint and its own permission.** `events.publish` is separate from
  `events.update`, so someone who may fix a typo cannot announce the event to the whole
  congregation. `status` is absent from the update schema entirely — the lifecycle lives at
  `POST /:id/status` (ADR-049).
- **A ministry leader may run their own event but not announce it.** They can create, edit, and
  move it through the lifecycle for their ministry — but publishing, deleting, and managing
  registrations stay on the branch permissions, because each reaches beyond the ministry
  (ADR-050).
- **An event happens at an instant, not a wall-clock time.** `starts_at`/`ends_at` are
  `timestamptz` and shown in the reader's zone — the opposite of a ministry's recurring meeting
  _time_, which is a plain `time` shown as written (ADR-051).
- **Capacity is a soft limit.** The check races by one under simultaneous registration; on a
  church event that is a chair, not a defect, so it is left open and recorded in
  [docs/SECURITY.md](docs/SECURITY.md) rather than paid for with a trigger (ADR-052).
- **A registration is a member or a guest, never both** — a guest carries their own name and
  optional contact, a member's contact comes from their record.

---

## Finance

Every transaction — income and expense — moves **draft → pending approval → approved**, with
**rejected** and **void** as the other outcomes. **Only approved rows count** toward any total.
The currency is the church's (GHS), read from settings and stamped server-side; it is never a
field on the form.

| Endpoint                                | Permission                  | Notes                         |
| --------------------------------------- | --------------------------- | ----------------------------- |
| `GET /api/transaction-categories`       | `finance.view`              | the shared vocabulary         |
| `POST /api/transaction-categories`      | `finance.categories.manage` |                               |
| `PATCH /api/transaction-categories/:id` | `finance.categories.manage` | rename / retire               |
| `GET /api/transactions`                 | `finance.view`              | list, filter, paginate        |
| `POST /api/transactions`                | `finance.create`            | records a draft               |
| `GET /api/transactions/:id`             | `finance.view`              | with capability flags         |
| `PATCH /api/transactions/:id`           | `finance.update`            | draft/rejected only           |
| `POST /api/transactions/:id/status`     | per transition¹             | submit, approve, reject, void |

¹ `pending_approval` needs `finance.submit`, `approved` `finance.approve`, `rejected`
`finance.reject`, `void` `finance.void`, and pulling a rejected item back to `draft`
`finance.update`. There is **no DELETE** — an approved transaction is reversed by voiding it,
which keeps the record and its reason.

Worth knowing:

- **The second signature.** `finance.approve` is not enough on its own: the approver must not be
  the person who submitted. Enforced by a database constraint (`transactions_no_self_approval`)
  that even a Super Administrator holding both permissions cannot bypass, and mirrored in the API
  as a clean 403 and a `canApprove` flag so the Approve button never appears for the submitter
  (ADR-055).
- **The currency is configured, not guessed.** It lives in `settings.finance.currency` (GHS),
  is read on each write, and the create refuses loudly if it is ever unset — a guessed currency is
  a ledger that is quietly wrong. It reaches the frontend through the session's public settings,
  which also carry the church name (ADR-053).
- **The lifecycle is its own endpoint** (ADR-054, the finance analogue of ADR-049): `status` is
  absent from the update schema, so approving cannot happen through a field edit.
- **Financial fields freeze once submitted.** Correcting an amount means rejecting the transaction
  first, so the change is visible — enforced by a database trigger, mirrored as a clear message.
- **Giving can be anonymous.** An offering may be recorded with no member attributed; a member's
  contribution names them, and an expense never does (owner decision Q4d).

---

## Reporting

Five reports — finance, members, attendance, ministries, events — each a filtered, dated summary
with headline numbers, proportion bars, and a CSV download. A report reads through the caller's own
client, so Row Level Security scopes the figures before they are summed; a report can never show a
total the caller could not reach one row at a time.

| Endpoint                              | Permission                | Notes                                    |
| ------------------------------------- | ------------------------- | ---------------------------------------- |
| `GET /api/reports/finance/summary`    | `reports.finance.view`    | income, expense, net, by type & category |
| `GET /api/reports/finance/export`     | `reports.finance.view`    | the same rows as CSV                     |
| `GET /api/reports/members/summary`    | `reports.members.view`    | by status and gender; joined-date filter |
| `GET /api/reports/members/export`     | `reports.members.view`    | CSV                                      |
| `GET /api/reports/attendance/summary` | `reports.attendance.view` | sessions, headcount, by gathering        |
| `GET /api/reports/attendance/export`  | `reports.attendance.view` | CSV                                      |
| `GET /api/reports/ministries/summary` | `reports.ministry.view`   | active membership per ministry           |
| `GET /api/reports/ministries/export`  | `reports.ministry.view`   | CSV                                      |
| `GET /api/reports/events/summary`     | `reports.event.view`      | by status, registration totals           |
| `GET /api/reports/events/export`      | `reports.event.view`      | CSV                                      |

Worth knowing:

- **No report loads unbounded rows.** Every read is capped at 5,000 with an exact count; a wider
  window is refused with a 409 asking to narrow it, rather than truncated (a wrong total) or
  streamed (an open-ended load). The aggregation is a pure reduction, unit-tested against
  hand-totalled fixtures, and money is summed in minor units so it does not drift (ADR-056).
- **The CSV is a real download, and safe to open.** It is served as a `text/csv` attachment, capped
  identically, gated on the report-view permission (the `*.export` permissions are for the raw
  operational lists), and any field that begins `=`, `+`, `-`, or `@` is neutralised so a spreadsheet
  cannot execute it as a formula (ADR-058).
- **The dashboard is role-specific.** Each widget appears only when the caller holds the report
  permission it draws from, uses the same summary endpoint as the full report, and degrades on its
  own if a query fails — one slow read does not blank the page (ADR-057).
- **No charting dependency.** Bars are native `<meter>` elements and CSS, which the strict CSP
  allows where an inline-styled bar would not (ADR-057).

---

## Audit log

Mutations write an audit row through `app.log_audit`, a `SECURITY DEFINER` function that takes the
actor from the JWT — so a client cannot forge who did a thing. The trail is **append-only in the
strongest sense**: no UPDATE or DELETE policy, plus triggers that refuse both for every role,
including the table owner and the service-role key.

| Endpoint               | Permission   | Notes                                   |
| ---------------------- | ------------ | --------------------------------------- |
| `GET /api/admin/audit` | `audit.view` | filter by action, resource, date; paged |

Worth knowing:

- **Writing is best-effort and never fails the operation it records.** A member edit that
  succeeded is not rolled back because the audit write hit a snag; the failure is logged as a
  warning instead. The database, not the log, is the source of truth for the record itself
  (ADR-059).
- **The log holds field names, not values.** A member update records `{ fields: [...] }`, never
  the new phone number — the audit trail is not a second copy of everyone's PII. `app.log_audit`
  also redacts any credential-looking key as a backstop.
- **Wired into every feature module.** Members, emergency contacts, families, ministries,
  attendance, events, and transactions all write their mutations to the trail.

---

## Settings

Church-wide configuration lives at `/admin/settings`, the in-app home for the values that a
migration seeds but an administrator tunes — the finance currency, the church name — with the
spiritual-gifts lookup edited on the same page.

| Endpoint                         | Permission        | Notes                               |
| -------------------------------- | ----------------- | ----------------------------------- |
| `GET /api/admin/settings`        | `settings.manage` | the global settings, ordered by key |
| `PATCH /api/admin/settings/:key` | `settings.manage` | edits the `value` only; dotted keys |

Worth knowing:

- **One permission gates the whole screen.** Both the list and the edit require `settings.manage`,
  because the editing page belongs to whoever may change a setting, not merely see one. `settings.view`
  is the RLS read grant behind the public-settings channel; it is deliberately not a key to this page
  (ADR-063).
- **Only the value changes, and the actor is stamped server-side.** The schema is `value`-only and
  strict, so a client cannot smuggle a `scope`, a `key`, or an `updated_by`; the session's user id is
  written as `updated_by`. Public settings still reach the browser through the session payload, not
  through this page (ADR-053).
- **The editor matches the control to the value's type** — a boolean is a Yes/No select, a number a
  number field, a string a text box, and a structured value is shown read-only so a text box cannot
  flatten it.

---

## Users

User administration at `/admin/users` invites accounts, edits profiles, activates or deactivates
them, and grants or revokes roles. There is deliberately **no delete**: an account with history is
deactivated, never removed.

| Endpoint                                     | Permission           | Notes                                     |
| -------------------------------------------- | -------------------- | ----------------------------------------- |
| `GET /api/admin/users`                       | `users.view`         | list; search, active/branch filter, paged |
| `GET /api/admin/users/roles`                 | `users.view`         | the assignable-role catalogue             |
| `POST /api/admin/users`                      | `users.invite`       | invite a new account by email             |
| `GET /api/admin/users/:id`                   | `users.view`         | one profile, with capability flags        |
| `PATCH /api/admin/users/:id`                 | `users.update`       | edit a profile                            |
| `POST /api/admin/users/:id/active`           | `users.deactivate`   | activate / deactivate                     |
| `POST /api/admin/users/:id/roles`            | `users.roles.manage` | grant a role                              |
| `DELETE /api/admin/users/:id/roles/:grantId` | `users.roles.manage` | revoke a grant                            |

Worth knowing:

- **Deactivate, never delete.** Removing the auth user would cascade through every record that
  references it, and the database has no `profiles` delete policy; deactivation revokes access
  through the `is_active` check every authorization helper makes (ADR-064).
- **Every guard is a mirror.** RLS on `profiles`/`roles`/`user_roles`, plus the escalation triggers
  (`profiles_guard_update`, `user_roles_guard_*` — no self-grant, no granting authority you lack,
  never remove the last active Super Administrator), are the real authority; the API refusals are
  the legible, before-the-round-trip version.
- **Self-service is refused early.** A user cannot change their own activation or their own role
  grants; the API says so plainly, and the trigger stays the non-bypassable backstop.
- **The invite reuses the reset-password page** to set an initial password; a dedicated
  invite-acceptance page is deferred.

---

## Roles

Role administration at `/admin/roles` is where the permission model itself is edited: create a
custom role, change any role's name, description, sort order, or permission set, and delete an
unused custom role. It is distinct from user administration's `users.roles.manage`, which hands an
existing role _to a person_ — this shapes what a role _is_.

| Endpoint                               | Permission     | Notes                                      |
| -------------------------------------- | -------------- | ------------------------------------------ |
| `GET /api/admin/roles`                 | `roles.manage` | every role, with permission + grant counts |
| `GET /api/admin/roles/permissions`     | `roles.manage` | the permission catalogue, grouped          |
| `POST /api/admin/roles`                | `roles.manage` | create a custom role; `key` is set once    |
| `GET /api/admin/roles/:id`             | `roles.manage` | the role, its permission ids, and its use  |
| `PATCH /api/admin/roles/:id`           | `roles.manage` | name, description, sort order; `key` fixed |
| `PUT /api/admin/roles/:id/permissions` | `roles.manage` | replaces the set; escalation-guarded       |
| `DELETE /api/admin/roles/:id`          | `roles.manage` | unused custom roles only                   |

Worth knowing:

- **One global permission gates the whole surface.** All seven routes require `roles.manage`, seeded
  global (branch id null); there is no branch-scoped or leadership path here. The database — RLS on
  `roles`/`permissions`/`role_permissions` plus the `roles_protect_system*` triggers — is the
  authority, and the handlers run on the user client under RLS (ADR-065).
- **Adding a permission you do not hold is refused.** When a permission is added to a role, the acting
  admin must themselves hold it. The database gates `role_permissions` on `roles.manage` alone and
  does not check this, so the guard lives in the API — a no-op today, but it closes a privilege
  escalation the moment `roles.manage` is delegated. Removals are always allowed.
- **`key` is immutable and system roles are protected.** The update schema omits `key` entirely, so
  it is asked for once on creation; `is_system` is never client input. A system role's name,
  description, and permissions can be edited, but it can never be deleted, and a role still granted
  to anyone is refused deletion with a written reason rather than a foreign-key error.

---

## Notifications

Two audiences share one surface. Everyone with `notifications.view` reads their own inbox at
`/notifications` and carries an unread badge — a bell and count in the top bar, read fresh on every
page load. Publishers (`notifications.create`, held by the senior pastor and secretary) compose an
announcement at `/admin/notifications`, target it at everyone, a role, or a branch, and manage what
they have sent. Delivery is in-app only.

| Endpoint                                 | Permission             | Notes                                           |
| ---------------------------------------- | ---------------------- | ----------------------------------------------- |
| `GET /api/notifications`                 | `notifications.view`   | the caller's own inbox, live only, newest first |
| `GET /api/notifications/unread-count`    | `notifications.view`   | the bare count behind the top-bar badge         |
| `POST /api/notifications/read-all`       | `notifications.view`   | marks every unread row read, scoped to caller   |
| `POST /api/notifications/:id/read`       | `notifications.view`   | marks one delivery read                         |
| `GET /api/admin/notifications`           | `notifications.create` | the published list, paginated, recipient counts |
| `GET /api/admin/notifications/audiences` | `notifications.create` | the role + branch pickers for compose           |
| `POST /api/admin/notifications`          | `notifications.create` | publish: create, fan out, audit the reach       |
| `GET /api/admin/notifications/:id`       | `notifications.create` | the notification and how many it reached        |
| `DELETE /api/admin/notifications/:id`    | `notifications.create` | retract; recipient rows cascade                 |

Worth knowing:

- **Two global permissions, split by direction.** `notifications.view` reads the inbox;
  `notifications.create` publishes. Both are seeded global (branch id null), so the whole surface is
  gated by the unscoped `context.can(...)`; there is no branch-scoped or leadership path. The
  database — RLS on `notifications` / `notification_recipients` — is the authority, and every handler
  runs on the user client (ADR-066).
- **Delivery is fan-out at publish time, resolved API-side.** A user sees a notification only through
  a `notification_recipients` row, so publishing materialises one row per recipient. Both publishers
  hold `users.view`, which is exactly the read the fan-out needs, so the audience is resolved with
  plain `profiles` / `user_roles` queries — no SECURITY DEFINER function. Publishing to a role or
  branch that matches nobody still creates the notification (recipient count 0).
- **The audience is everyone, a role, or a branch — never one person.** A single-recipient direct
  message reads more like messaging than an announcement and is out of scope; the `user` audience and
  the automated `event_reminder` type are refused by the create schema. `created_by` is stamped from
  the session, never the client, and `.strict()` rejects any unknown key.
- **Reads are not audited; publish and retract are.** Marking an item read is per-user and
  high-volume with no security value. Publishing and retraction are the consequential acts and the
  only ones written to the trail. Retraction cascades, so a notification vanishes from every inbox
  at once.

---

## Security posture

Full assessment, including the known gaps: **[docs/SECURITY.md](docs/SECURITY.md)**.

The load-bearing parts:

- **No credentials in the browser.** There is no client-exposed environment variable at all.
- **Strict CSP** — `default-src 'self'`, no `unsafe-inline`, no CDN. Consequences: no inline
  `<script>`, no `style=""` attributes (`el()` throws if you try), and the theme is applied by
  a tiny same-origin classic script so there is no flash of the wrong colour scheme.
- **Deny-by-default routing.** A route must declare `public: true` or a `permission`, and a
  permissioned route cannot be registered until the enforcement guards are wired in. Both
  failures throw at cold start rather than shipping a hole.
- **Errors never leak.** One mapper turns any thrown value into `{ code, message, requestId }`.
  Stack traces, database text, and filesystem paths go to the log only. Asserted by a test.
- **Logs redact by key name** — anything matching password/token/secret/key/authorization/cookie
  is masked before it is written, rather than relying on callers to remember.
- **The service-role Supabase client is import-restricted** by an ESLint rule to an explicit
  allow-list, because it bypasses RLS entirely.
- **`innerHTML`, `outerHTML`, and `insertAdjacentHTML` are ESLint errors** in frontend code.
- **Header drift is a test failure.** The CDN reads security headers from `vercel.json` and
  the API builds them in JavaScript; a test parses both and asserts they match.

Added in Phase 2, and tested as each role:

- **Row Level Security on all 25 tables**, with the database — not the API — as the final
  authority. 68 policies, plus 15 on `storage.objects`.
- **Privilege escalation guards**: nobody edits their own role grants, nobody grants authority
  they do not hold in that scope, and the last active Super Administrator cannot be removed.
- **Deactivating a user removes their database access**, not just their session: every
  authorization helper checks `profiles.is_active`.
- **Every SECURITY DEFINER function pins `search_path`** — a test fails if one does not.
- **Financial and audit immutability** enforced by constraints and triggers rather than by
  convention.

Added in Phase 12: **audit-log writing** from the mutation paths of every feature module through
`app.log_audit`, readable at `/admin/audit`; **emergency contacts**; **member photo upload**
brokered through signed Storage URLs; **spiritual gifts** as a controlled lookup with a
per-member join; and the **settings admin** at `/admin/settings`, where church-wide configuration
and the gifts lookup are edited under `settings.manage`.

---

## Build status

| Phase                | Status                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Foundation       | ✅ complete (79 unit tests)                                                                                                               |
| 2 — Database         | ✅ schema, RLS, and seed complete (137 database tests)                                                                                    |
| 3 — Authentication   | ✅ complete against a fake provider — **not yet run on real Supabase**                                                                    |
| 4 — Authorization    | ✅ RLS in Phase 2, API guards in Phase 3, both exercised by Members                                                                       |
| 5 — Members          | ✅ CRUD, search, filters, pagination, soft delete and restore, the restricted directory (75 further tests)                                |
| 6 — Families         | ✅ households, membership with relationships, the one-head and one-household rules (58 further tests)                                     |
| 7 — Ministries       | ✅ ministries, leadership scope through the API, membership with history (62 further tests)                                               |
| 8 — Attendance       | ✅ sessions, the atomic register, headcounts, closing, per-member history (67 further tests)                                              |
| 9 — Events           | ✅ events, the draft→publish lifecycle, registrations with guests, the calendar view (75 further tests)                                   |
| 10 — Finance         | ✅ income/expense, the submit→approve lifecycle, the two-signature rule, anonymous giving (48 further tests)                              |
| 11 — Reporting       | ✅ five capped, RLS-scoped report summaries, role-specific dashboard, CSV export (45 further tests)                                       |
| 12 — Feature modules | ✅ audit writing (every module) + viewer, emergency contacts, member photo upload, spiritual gifts, the settings admin (68 further tests) |
| 13 — Security & QA   | 🟨 user, role & notification administration built (128 further tests); real-Supabase verification, Git, and QA still open                 |
| 14 — Production      | ⬜                                                                                                                                        |

**827 unit and API tests + 137 database tests = 964, all passing.**

_This session's run: the 827 unit and API tests pass; the 137 database tests could not be run here
because PGlite crashed on start in this environment. The unit total now includes the user-, role-,
and notification-administration suites (+128 since Phase 12). No migration was added since Phase 10,
so the database figure is unchanged from its last verified run._

Not yet done, and not claimed:

- **Nothing is committed to Git** — Git is not installed on this machine.
- **No Supabase project exists.** The schema has never run on real Supabase; it is verified
  against PGlite with Supabase shims (ADR-019). Sign-in has never spoken to real GoTrue, and
  the member queries have never reached PostgREST; both are verified against injected fakes
  that record what was asked of them. These are honest substitutes with stated limits, not
  claims of a working integration.
- **Member photo upload is built but its Storage round-trip is unverified.** The API brokers
  a signed upload URL and a signed read URL, and the UI drives the handshake; but Supabase
  Storage's own MIME/size enforcement and the signed-URL wire format have not been run against a
  real project — they are tested against a shim that records the calls (ADR-061).
- **Spiritual gifts (decision D7) is built** as a controlled lookup plus a per-member join:
  the lookup is edited under `settings.manage`, and gifts are attached to a member under
  `members.update`. The lookup-management screen now lives on the settings admin page, alongside
  the church-wide settings (ADR-062, ADR-063).
- **Audit writing is best-effort, by design.** `app.log_audit` is called from the mutation paths
  of every feature module — members, emergency contacts, families, ministries, attendance, events,
  and transactions — and the append-only trail is readable at `/admin/audit`. A failed audit write
  is logged, never fatal to the operation it records (ADR-059).
- **The password-reset email needs a template change in the Supabase dashboard** before the
  emailed link reaches our endpoint — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- **Rate limiting is per-instance**, so a distributed attacker gets a multiple of the nominal
  limit. Known and scheduled for Phase 13 (ADR-027).
- Nothing has been deployed to Vercel. The `vercel.json` rewrite has been exercised only
  against the local dev server, which implements the same routing contract.
- Storage policies are verified against shimmed `storage` tables, not the real service.
- Three questions still shape the data: the role matrix (Q1), the currency (Q4c), and whether
  a tithe must always name a member (Q4d). All three are data or one-line constraints, not
  schema rewrites.
