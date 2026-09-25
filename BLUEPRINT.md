# Church Management System — PROJECT BLUEPRINT

**Status:** **APPROVED 2026-08-26** — Phases 1 (Foundation), 2 (Database), and 3 (Authentication) complete and tested. Members (Phase 5) next.
**Date:** 2026-08-26, last updated 2026-08-31
**Working directory:** `D:\PY\update`

### Approved decisions (see `docs/DECISIONS.md` for the ADR log)

| #   | Decision          | Answer                                                                                                                                                 |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Core architecture | **Approved as proposed** — static frontend + single Vercel Function BFF + Supabase, `HttpOnly` cookie sessions, no web framework                       |
| D2  | Multi-branch      | **Schema multi-branch from migration 0001, UI single-branch**                                                                                          |
| D3  | Finance approval  | **All transactions require approval** — income _and_ expenses. Only approved transactions count toward reports                                         |
| D4  | Member logins     | **Admin-created only.** A member sees their own profile and their own attendance history. Giving history is **not** exposed                            |
| D5  | Attendance        | **Named records _and_ aggregate headcounts** — the roll for follow-up, the headcount for the true total                                                |
| D6  | Finance approvers | **Senior Pastor + Super Admin** approve/reject/void; Finance Officer records and submits. **No self-approval** — `CHECK (approved_by <> submitted_by)` |
| D7  | Member fields     | **Spiritual gifts as a controlled lookup list** so gift-based reporting works; free-text `notes` retained                                              |
| D8  | Local database    | **Docker Desktop + `supabase start`** — real local Postgres/Auth/Storage, and pgTAP tests for RLS                                                      |

> Sections 1–14 are the architecture. Section 15 lists the questions still open.
> Section 16 states exactly which platform facts were verified and which remain assumptions.
> Implementation status per phase is in `README.md`.

---

## 1. RECOMMENDED ARCHITECTURE

### 1.1 Chosen shape: static frontend + Vercel Functions BFF + Supabase

```
Browser (HTML5 / CSS3 / vanilla ES modules / Bootstrap 5)
   │  fetch()  — same-origin only, HttpOnly session cookies
   ▼
Vercel Edge Network (CDN)
   ├── /                     → static assets from public/   (cached, no compute)
   └── /api/*                → one Node.js 24 Vercel Function (the BFF)
                                 │
                                 │ 1. parse + verify session cookie
                                 │ 2. resolve user + permissions
                                 │ 3. authorize the route
                                 │ 4. validate the payload (zod)
                                 │ 5. call Supabase as the *user*
                                 │ 6. audit-log the mutation
                                 ▼
                      Supabase (single region, matched to the Vercel function region)
                          ├── PostgreSQL + Row Level Security  ← final authority
                          ├── Auth (GoTrue)                    ← password + token issuance
                          └── Storage (private buckets)        ← photos, receipts
```

**The browser never holds a Supabase key and never talks to Supabase directly.** All
Supabase traffic originates from the serverless function. This is the Backend-for-Frontend
(BFF) pattern.

### 1.2 Why a BFF instead of "browser talks to Supabase with the anon key"

The common Supabase pattern (browser uses `supabase-js` with the anon key, RLS is the only
guard) is legitimate, but it has three properties this project's own requirements reject:

| Requirement in the brief                                   | Direct-to-Supabase                                                                    | BFF                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| §3 "Secure Server/API Layer" between frontend and Supabase | absent                                                                                | present                                              |
| §28 XSS token theft                                        | access **and refresh** tokens live in `localStorage`, readable by any injected script | tokens in `HttpOnly` cookies, unreadable by JS       |
| §22 audit logging that users cannot forge                  | client controls what gets written                                                     | server writes audit rows the client cannot influence |
| §19 "do not load unnecessary data into the browser"        | aggregation happens client-side or needs DB functions                                 | aggregation happens server-side                      |

Cost of the BFF: one extra network hop (~20–60 ms if the function and the database share a
region), and we must implement token refresh ourselves. Both are acceptable and bounded.

### 1.3 Request lifecycle (mutating request)

```
POST /api/members
  ↓ Vercel CDN → BFF function
  ↓ middleware: withRequestId      → attaches a correlation id used in every log line
  ↓ middleware: withSession        → reads cma_at / cma_rt cookies, refreshes if expiring
  ↓ middleware: withCsrf           → double-submit token + Origin check (state-changing only)
  ↓ middleware: withPermission     → 'members.create' in the target branch, else 403
  ↓ middleware: withValidation     → zod schema; 422 with field errors on failure
  ↓ handler                        → supabaseForUser(accessToken).from('members').insert(...)
  ↓                                  RLS re-checks the same permission independently
  ↓ audit                          → app.log_audit('member.created', 'member', id, diff)
  ↓ response                       → { data: {...} }   |   { error: { code, message, requestId } }
```

**Authorization is enforced twice, deliberately.** The API check produces good error
messages and blocks the request early; the RLS policy is the thing that cannot be bypassed
even if the API layer has a bug. Neither is trusted to be the only guard.

---

## 2. TECHNOLOGY DECISIONS AND JUSTIFICATION

| Layer             | Decision                                                         | Why                                                                                                                                                                         | Rejected alternative                                                                    |
| ----------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Frontend          | HTML5 + CSS3 + native ES modules, no build step                  | Mandated by brief §2. Modern browsers load ESM natively; no bundler means no build-config maintenance and no source-map/secret leakage risk                                 | React/Vue SPA — adds a framework and a build pipeline the brief did not approve         |
| CSS               | Bootstrap 5.3, **vendored locally** (not CDN)                    | Gives responsive grid, accessible components, and native dark mode via `data-bs-theme`. Vendoring lets us serve a strict CSP without `unsafe-inline` or third-party origins | Tailwind (needs a build step); hand-rolled CSS (slower, worse a11y)                     |
| Backend           | Vercel Functions, Node.js 24, **no web framework**               | Native to Vercel; zero framework dependency. Routing is a ~60-line table-driven dispatcher                                                                                  | Express (a framework, plus duplicate routing); Next.js (drags in React, contradicts §2) |
| API surface       | **One** function at `api/index.js`, all `/api/*` rewritten to it | Vercel Hobby caps a no-framework project at **12 functions per deployment** (verified). One function also means one warm instance, shared middleware, and one bundle        | One file per endpoint — hits the 12-function cap by the time Members + Attendance exist |
| Validation        | `zod`                                                            | Single schema definition reused for validation and for generated error messages; server-side by default                                                                     | Hand-written validators (error-prone, verbose)                                          |
| DB access         | `@supabase/supabase-js` over PostgREST                           | Parameterized by construction (no SQL string building → no SQL injection), respects RLS, no connection-pool management in serverless                                        | `pg` + raw SQL — needs a pooler (Supavisor) and hand-written parameterization           |
| Auth              | Supabase Auth (GoTrue), driven server-side                       | Battle-tested password hashing, reset tokens, email verification. §10 forbids custom password storage                                                                       | Custom auth — explicitly forbidden                                                      |
| Session transport | `HttpOnly; Secure; SameSite=Lax` cookies set by the BFF          | Not readable by injected JS                                                                                                                                                 | `localStorage` (XSS-exfiltratable)                                                      |
| Storage           | Supabase Storage, private buckets, signed URLs                   | Access control follows the same identity as the DB                                                                                                                          | Public bucket (leaks member photos to anyone with the URL)                              |
| Tests             | `node:test` (built in) + pgTAP via Supabase CLI + Playwright     | pgTAP is the only honest way to test RLS: it runs _inside_ the database. Zero runtime deps added                                                                            | Jest/Vitest — extra dependency for no gain over `node:test`                             |
| Deps total        | **2 runtime dependencies** (`@supabase/supabase-js`, `zod`)      | §45 "no unnecessary dependencies"                                                                                                                                           | —                                                                                       |

### 2.1 Frontend page architecture (no framework, no duplication)

Multi-page app. Each route is a thin static HTML shell; the sidebar, topbar, and page body
are rendered by a shared ES module, so navigation chrome exists in exactly one place.

```html
<!-- public/members/index.html -->
<!doctype html>
<html lang="en" data-bs-theme="light">
  <head>
    …
    <link rel="stylesheet" href="/assets/vendor/bootstrap/bootstrap.min.css" />
    …
  </head>
  <body>
    <div id="app" data-page="members-list" aria-busy="true"></div>
    <script type="module" src="/assets/js/pages/members-list.js"></script>
  </body>
</html>
```

`members-list.js` imports `renderShell()` (nav, theme toggle, user menu, permission-aware
menu items) and then renders the page body. No inline scripts anywhere — required for the
strict CSP in §8.

Trade-off, stated plainly: navigation chrome is client-rendered, so there is a brief skeleton
state on first paint. For an authenticated back-office app this is the right trade; it would
not be for a public marketing site. Cache-busting is done with `?v=<hash>` query strings
maintained by a small npm script.

---

## 3. RECOMMENDED PROJECT STRUCTURE

```
church-management-system/
├── api/
│   └── index.js                  # the ONLY serverless entrypoint; delegates to src/server
├── public/                        # static, CDN-served, zero compute
│   ├── index.html                 # login
│   ├── dashboard/index.html
│   ├── members/index.html
│   ├── members/detail.html
│   ├── families/ ministries/ attendance/ events/ finance/ reports/ admin/
│   ├── assets/
│   │   ├── css/tokens.css         # design tokens (light + dark)
│   │   ├── css/app.css
│   │   ├── js/
│   │   │   ├── core/              # api-client, session, toast, modal, theme, format
│   │   │   ├── components/        # data-table, pagination, filter-bar, empty-state, skeleton
│   │   │   └── pages/             # one module per page
│   │   └── vendor/bootstrap/      # vendored, version-pinned
│   └── icons/ img/
├── src/                           # server-side only — never shipped to the browser
│   ├── server/
│   │   ├── router.js              # method+path table → handler
│   │   ├── middleware/            # request-id, session, csrf, permission, validate, error
│   │   └── routes/
│   │       ├── auth.routes.js  members.routes.js  families.routes.js
│   │       ├── ministries.routes.js  attendance.routes.js  events.routes.js
│   │       ├── finance.routes.js  reports.routes.js  users.routes.js
│   │       └── notifications.routes.js  audit.routes.js  settings.routes.js
│   ├── services/                  # business logic; the only place that talks to Supabase
│   ├── data/
│   │   ├── supabase-user.js       # anon key + caller's JWT  → RLS applies  (DEFAULT)
│   │   └── supabase-admin.js      # service-role key         → RLS bypassed (RESTRICTED)
│   ├── auth/                      # session cookies, token refresh, permission resolver
│   ├── validation/                # zod schemas, one file per resource
│   ├── lib/                       # errors, logger, pagination, storage, audit, config
│   └── config/env.js              # fail-fast env validation at cold start
├── supabase/
│   ├── config.toml
│   ├── migrations/                # NNNN_description.sql, forward-only, committed
│   ├── seed.sql                   # roles, permissions, categories — non-personal data only
│   └── tests/                     # pgTAP: rls_members.sql, rls_finance.sql, …
├── tests/
│   ├── unit/  integration/  authz-matrix/  e2e/
├── docs/
│   ├── ARCHITECTURE.md  DATABASE.md  SECURITY.md  DEPLOYMENT.md
│   ├── API.md  RBAC.md  DECISIONS.md   # DECISIONS.md = ADR log
├── scripts/
│   ├── dev-server.mjs             # zero-dep local host for public/ + the API handler
│   └── vendor-refresh.mjs         # copies pinned Bootstrap dist into public/assets/vendor/
├── .env.example                   # names only, never values
├── .gitignore  eslint.config.js  .prettierrc  package.json  vercel.json  README.md
```

**Enforced rule:** `supabase-admin.js` may only be imported by an explicit allow-list of
modules (user provisioning, audit writer, cross-branch reports). An ESLint
`no-restricted-imports` rule makes a violation a build failure rather than a code-review
memory test.

---

## 4. SUPABASE ARCHITECTURE

### 4.1 Environments

| Environment | Supabase project          | Used by                                          |
| ----------- | ------------------------- | ------------------------------------------------ |
| Local       | `supabase start` (Docker) | day-to-day development, pgTAP, integration tests |
| Staging     | dedicated cloud project   | Vercel Preview deployments, QA                   |
| Production  | dedicated cloud project   | Vercel Production only                           |

Preview deployments must **never** point at production. Vercel scopes env vars per
environment (Development / Preview / Production), which is how we enforce that.

**Region:** Vercel Functions default to `iad1` (Washington, D.C.) — verified. The Supabase
project must be created in the geographically matching region, or the Vercel function region
must be changed to match Supabase. A mismatch adds 100–250 ms to _every_ database round trip.
This is a launch-time decision, not something to fix later. See open question Q7.

### 4.2 Schemas

| Schema            | Contents                                                         | Exposed via PostgREST                    |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| `public`          | application tables and views                                     | yes                                      |
| `app`             | RLS helper functions, audit writer, `SECURITY DEFINER` utilities | no (revoked from `anon`/`authenticated`) |
| `auth`, `storage` | Supabase-managed                                                 | no                                       |

### 4.3 Migrations

Forward-only numbered SQL files, authored locally, applied with `supabase db push`, committed
to Git. Production schema is never edited by hand in the dashboard. Every migration must be
runnable against an empty database to reproduce the full schema.

### 4.4 Storage buckets

| Bucket             | Visibility       | Contents              | Path convention                                         | Max size |
| ------------------ | ---------------- | --------------------- | ------------------------------------------------------- | -------- |
| `member-photos`    | private          | member profile photos | `{branch_id}/{member_id}/{uuid}.webp`                   | 2 MB     |
| `user-avatars`     | private          | staff avatars         | `{user_id}/{uuid}.webp`                                 | 1 MB     |
| `finance-receipts` | private          | receipts / vouchers   | `{branch_id}/{yyyy}/{mm}/{transaction_id}/{uuid}.{ext}` | 5 MB     |
| `event-media`      | private (signed) | event images          | `{branch_id}/{event_id}/{uuid}.{ext}`                   | 5 MB     |

Every bucket is private. Reads are served through short-lived signed URLs (60 s) minted by
the BFF only after it has confirmed the caller may see the parent record. Uploads go through
the BFF, which validates magic bytes (not just the declared MIME type), regenerates the
filename as a UUID, and strips the client-supplied path entirely. `storage.objects` RLS
policies are keyed on the first path segment (branch) as a second line of defence.

---

## 5. DATABASE ERD PROPOSAL

### 5.1 Relationship map

```
branches ──1:N── members ──0:1── auth.users          (staff logins only; most members: NULL)
    │                │
    │                ├──1:N── member_emergency_contacts
    │                ├──M:N── spiritual_gifts        via member_spiritual_gifts
    │                ├──M:N── families               via family_members  (+ relationship)
    │                ├──M:N── ministries             via ministry_members (+ role, dates)
    │                ├──1:N── attendance_records
    │                └──0:N── transactions           (nullable: anonymous offerings exist)
    │
    ├──1:N── families
    ├──1:N── ministries
    ├──1:N── events ──N:1── event_categories
    │           └──1:N── event_registrations
    ├──1:N── attendance_sessions ──1:N── attendance_records
    │           └──0:1── events           (event-type sessions)
    │           └──0:1── ministries       (ministry-type sessions)
    └──1:N── transactions ──N:1── transaction_categories

auth.users ──1:1── profiles ──1:N── user_roles ──N:1── roles ──M:N── permissions
                                         └── branch_id (NULL = all branches)

audit_logs        (insert-only, no FK to keep history after deletes)
notifications ──1:N── notification_recipients ──N:1── profiles
settings          (key/value, global or per-branch)
```

### 5.2 Table specifications

Conventions applied to every table: `id uuid primary key default gen_random_uuid()`,
`created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`
maintained by a shared trigger, `created_by`/`updated_by uuid references auth.users`.
All timestamps are `timestamptz`; all money is `numeric(14,2)`; no `float` anywhere near money.

**Identity & access**

| Table              | Key columns                                                                                                    | Constraints / indexes                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `branches`         | `code` text, `name`, `address`, `city`, `region`, `country`, `phone`, `email`, `timezone`, `is_active`         | `unique(code)`; `unique(lower(name))`                                         |
| `profiles`         | `id` = `auth.users.id`, `full_name`, `phone`, `avatar_path`, `default_branch_id`, `is_active`, `last_login_at` | FK `id → auth.users on delete cascade`; index on `default_branch_id`          |
| `roles`            | `key` (`super_admin`…), `name`, `description`, `is_system`                                                     | `unique(key)`; `is_system` rows undeletable via trigger                       |
| `permissions`      | `key` (`members.create`), `resource`, `action`, `description`                                                  | `unique(key)`; `unique(resource, action)`                                     |
| `role_permissions` | `role_id`, `permission_id`                                                                                     | PK `(role_id, permission_id)`; index on `permission_id`                       |
| `user_roles`       | `user_id`, `role_id`, `branch_id` NULL = all branches, `granted_by`, `granted_at`                              | `unique(user_id, role_id, coalesce(branch_id, uuid_nil))`; index on `user_id` |

**Members**

| Column group | Columns                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity     | `member_no` text (generated `BR-000123`, unique), `branch_id` NOT NULL, `user_id` unique NULL                                                               |
| Personal     | `first_name`, `middle_name`, `last_name`, `gender` enum, `date_of_birth`, `marital_status` enum, `occupation`                                               |
| Contact      | `phone`, `alt_phone`, `email`, `address_line`, `city`, `region`, `country`, `nationality`                                                                   |
| Church       | `membership_status` enum(`visitor`,`new`,`active`,`inactive`,`transferred`,`deceased`), `date_joined`, `is_baptized`, `baptism_date`, `photo_path`, `notes` |
| Lifecycle    | `created_by`, `updated_by`, `created_at`, `updated_at`, `deleted_at` (soft delete)                                                                          |

Constraints: `check (date_of_birth <= current_date)`; `check (date_joined >= date_of_birth)`;
`check (not is_baptized) or (baptism_date is not null)`; `check (baptism_date is null or is_baptized)`;
email format check; `unique(branch_id, lower(email)) where email is not null and deleted_at is null`
(partial, so soft-deleted rows don't block reuse).

Indexes: `(branch_id, membership_status)`, `(branch_id, deleted_at)`, `(date_joined)`,
`(last_name, first_name)`, and a generated `search_vector tsvector` column
(`first || middle || last || member_no || phone || email`) with a **GIN** index for §26 search.
Search is therefore database-side and index-backed, never a client-side filter.

_Field justification per §13:_ every field above is either in the brief's own list or is
structural (`branch_id`, `deleted_at`, audit columns). Nothing sensitive was invented.
Notably **absent**, deliberately: national ID number, income bracket, health information, and
giving totals denormalised onto the member row.

Per **D7**: `notes` (free text) is retained, and spiritual gifts are a controlled lookup —
`spiritual_gifts(name unique, description)` plus `member_spiritual_gifts(member_id, gift_id)`
with PK `(member_id, gift_id)` — so "who has the gift of teaching" is an indexed query rather
than a text search across three spellings of the same word.

**Families / Ministries**

- `families(branch_id, family_name, household_phone, household_email, address_line, city, region, head_member_id NULL)`; `unique(branch_id, lower(family_name))`.
- `family_members(family_id, member_id, relationship enum, is_dependent)`, PK `(family_id, member_id)`, plus a **partial unique index enforcing at most one `head` per family**.
- `ministries(branch_id, name, code, description, status enum, meeting_day, meeting_time)`; `unique(branch_id, lower(name))`.
- `ministry_members(ministry_id, member_id, role_in_ministry enum(leader, assistant_leader, member), joined_on, left_on NULL)` with a **partial unique index on `(ministry_id, member_id) where left_on is null`** so a member cannot hold two concurrent memberships but history is preserved. `ministry_members` is also the authoritative source for "is this user a leader of this ministry", used by RLS.

**Attendance** (per decision **D5** — named records _and_ aggregate headcounts)

- `attendance_sessions(branch_id, session_type enum(service, event, ministry), title, session_date, start_time, end_time, ministry_id NULL, event_id NULL, status enum(open, closed), closed_at, recorded_by)`
  with a `CHECK` that ties type to reference: `ministry` requires `ministry_id`, `event` requires `event_id`, `service` requires both NULL.
  **Headcount columns** (D5): `count_adults`, `count_youth`, `count_children`, `count_visitors`, each `integer NOT NULL DEFAULT 0 CHECK (>= 0)`, plus a generated `count_total`.
  The headcount is the authoritative total; named records are a subset of it, so a report shows both "212 present" and "148 identified". A `CHECK (count_total = 0 or count_total >= named_count)` is _not_ imposed — the counts are captured independently by ushers and reconciling them is a human task, not a database constraint.
- `attendance_records(session_id, member_id NULL, guest_name NULL, status enum(present, absent, late, excused), check_in_at, method enum(manual, search, qr), recorded_by)`
  — `unique(session_id, member_id) where member_id is not null`; `CHECK (member_id is not null or guest_name is not null)`.
  Index `(member_id, session_id)` for per-member history.

**Events**

- `event_categories(name unique, colour)`.
- `events(branch_id, category_id, title, description, starts_at, ends_at, venue, organizer_member_id NULL, ministry_id NULL, status enum(draft, published, ongoing, completed, cancelled), is_public, capacity NULL)`;
  `CHECK (ends_at > starts_at)`; index `(branch_id, starts_at)` for the calendar; `(status, starts_at)` for "upcoming".
- `event_registrations(event_id, member_id NULL, guest_name, guest_phone, status enum(registered, cancelled, no_show), registered_at)`; `unique(event_id, member_id) where member_id is not null`.
  Actual attendance is recorded through `attendance_sessions`, not duplicated here — one
  attendance mechanism, not two.

**Finance** (single-table design; approval workflow per decision **D3**)

`transactions(branch_id, kind enum(income, expense), category_id, income_type enum(tithe, offering, donation, other) NULL, member_id NULL, amount numeric(14,2) CHECK (amount > 0), currency char(3), occurred_on date, payment_method enum(cash, mobile_money, bank_transfer, cheque, card, other), reference, description, receipt_path, status enum(draft, pending_approval, approved, rejected, void), recorded_by, submitted_by, submitted_at, approved_by, approved_at, rejected_by, rejected_at, rejection_reason, voided_by, voided_at, void_reason)`

Plus `transaction_categories(kind, name, code, is_active)` with `unique(kind, lower(name))`.

Approval lifecycle (D3 — applies to **income and expenses alike**):

```
draft ──submit──▶ pending_approval ──approve──▶ approved ──void──▶ void
  ▲                      │
  └──────edit────── rejected ◀──reject──┘
```

Rules baked into the schema:

- **Only `approved` rows count toward any report or dashboard figure.** Every financial query filters `status = 'approved'`; there is no code path where a pending row inflates a total.
- `amount`, `kind`, `category_id`, `occurred_on`, and `member_id` are **immutable once the row leaves `draft`/`rejected`** (trigger-enforced). Editing requires rejection first.
- **No `DELETE`, ever.** An approved transaction is reversed by voiding it, which preserves the row and the reason.
- Separation of duties (**D6**): `CHECK (approved_by is null or approved_by <> submitted_by)` — nobody approves their own entry.
- `CHECK (kind = 'income' or income_type is null)` — expenses have no income type.
- `CHECK (member_id is null or kind = 'income')` — expenses aren't attributed to members.
- Indexes: `(branch_id, status, occurred_on)` (the reporting index), `(branch_id, kind, occurred_on) where status = 'approved'`, `(status) where status = 'pending_approval'` (the approval queue), `(category_id)`, `(member_id) where member_id is not null`.

One table with a `kind` discriminator is recommended over separate `income`/`expenses`/`tithes`/
`offerings` tables because every report in §19 needs both sides together, and four tables would
mean four nearly identical policy sets, four validators, four approval workflows, and `UNION`
queries for every report.

_Operational consequence of D3, stated plainly:_ a Sunday offering cannot appear in any total
until a second authorised person approves it. The approval queue therefore becomes a routine
weekly task, and the MVP needs at least two staff accounts holding finance permissions or the
books will stall. **D6** settles who: Senior Pastor and Super Administrator approve, reject, and
void; the Finance Officer records and submits and may not approve their own entry.

**Cross-cutting**

- `audit_logs(id bigserial, actor_user_id NULL, actor_email text, action text, resource_type text, resource_id text, branch_id NULL, changes jsonb, ip inet, user_agent text, request_id text, occurred_at timestamptz)`.
  RLS: `SELECT` requires `audit.view`; **`UPDATE` and `DELETE` have no policy at all**, so they are impossible for every role including `authenticated`. Writes go through `app.log_audit(...)` (`SECURITY DEFINER`). Snapshot columns (`actor_email`) rather than FK to survive user deletion. Index `(occurred_at desc)`, `(resource_type, resource_id)`, `(actor_user_id)`.
- `notifications(branch_id NULL, title, body, type enum(system, announcement, event_reminder, admin), severity enum(info, warning, critical), audience enum(all, role, branch, user), audience_role_id NULL, created_by, published_at, expires_at)` + `notification_recipients(notification_id, user_id, read_at)` PK `(notification_id, user_id)`, index `(user_id) where read_at is null` for the unread badge.
- `settings(scope enum(global, branch), branch_id NULL, key text, value jsonb, updated_by)`; `unique(scope, coalesce(branch_id, uuid_nil), key)`.

### 5.3 Multi-branch decision

`branch_id` is present from migration 0001 on every branch-scoped table, and `branches` is
seeded with one default branch. Retrofitting a tenant column into a live schema with RLS
policies and unique constraints is genuinely painful; adding the column now costs almost
nothing. The **UI** stays single-branch until you ask for more (see Q2), but the **schema and
RLS** are multi-branch from day one.

---

## 6. AUTHENTICATION ARCHITECTURE

### 6.1 Session model

Supabase Auth issues the tokens; the BFF holds them.

| Cookie     | Contents                    | Flags                                                 | Lifetime                |
| ---------- | --------------------------- | ----------------------------------------------------- | ----------------------- |
| `cma_at`   | Supabase access token (JWT) | `HttpOnly; Secure; SameSite=Lax; Path=/`              | ~1 h (Supabase setting) |
| `cma_rt`   | Supabase refresh token      | `HttpOnly; Secure; SameSite=Strict; Path=/api/auth`   | Supabase setting        |
| `cma_csrf` | random 32-byte token        | `Secure; SameSite=Lax` (readable by JS **by design**) | session                 |

`cma_rt` is scoped to `Path=/api/auth`, so it is not even transmitted on ordinary API calls —
only to the endpoints that can use it. `cma_csrf` is the only non-`HttpOnly` cookie; it is a
CSRF token, not a credential, and is worthless without the session cookies.

### 6.2 Flows

| Flow                 | Endpoint                                                           | Behaviour                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login                | `POST /api/auth/login`                                             | BFF calls `signInWithPassword`; on success sets the three cookies and returns the user + permission list. Uniform error message and constant-ish response time for wrong-email vs wrong-password (no account enumeration).               |
| Whoami               | `GET /api/auth/session`                                            | Returns user, roles, permissions, accessible branches. Frontend calls this before rendering any protected page.                                                                                                                          |
| Refresh              | handled inside `withSession`                                       | If the access token expires within 60 s, refresh once and re-issue cookies. Concurrent-refresh races are avoided by refreshing only on `GET /api/auth/session`, which the client calls on a timer and after any 401 (then retries once). |
| Logout               | `POST /api/auth/logout`                                            | Revokes the refresh token server-side and clears cookies with `Max-Age=0`.                                                                                                                                                               |
| Password reset       | `POST /api/auth/password/forgot` → `POST /api/auth/password/reset` | Supabase email link → our page → BFF completes it. `forgot` returns 200 whether or not the email exists.                                                                                                                                 |
| Email verification   | Supabase setting                                                   | On for staff invitations.                                                                                                                                                                                                                |
| Account deactivation | `PATCH /api/users/:id`                                             | Sets `profiles.is_active = false`; `withSession` rejects inactive users on the _next_ request, and the refresh token is revoked immediately so a stolen access token dies within the hour.                                               |
| Protected pages      | client + server                                                    | Client-side gating is UX only. Every `/api/*` route authorizes independently, and RLS below that.                                                                                                                                        |

### 6.3 Registration

**Self-service public registration is deliberately not proposed.** A church management system's
users are staff; open sign-up is an attack surface with no owner. Instead: admin-initiated
invitation (`POST /api/users/invite`) → Supabase invite email → user sets their password.
If you do want public member self-registration, that is Q6 — it needs a different flow
(unverified applicant records requiring approval, not real user accounts).

---

## 7. RBAC ARCHITECTURE

### 7.1 Model

```
user → user_roles (scoped to a branch, or global) → roles → role_permissions → permissions
```

No role names appear in business logic. Code asks `can('finance.approve', branchId)`, never
`if (role === 'finance_officer')`. Roles are data; adding a role is an INSERT, not a deploy.

### 7.2 Permission catalogue (proposed, ~48 permissions)

```
members.view            members.view_directory   members.create      members.update
members.delete          members.export           members.photo.manage

families.view           families.create          families.update     families.delete

ministries.view         ministries.create        ministries.update   ministries.delete
ministries.members.manage

attendance.view         attendance.session.create attendance.session.close
attendance.record       attendance.update        attendance.delete

events.view             events.create            events.update       events.delete
events.publish          events.attendance.manage

finance.view            finance.create           finance.update      finance.submit
finance.approve         finance.reject           finance.void        finance.export
finance.categories.manage

reports.members.view    reports.attendance.view  reports.ministry.view
reports.event.view      reports.finance.view

users.view              users.invite             users.update        users.deactivate
users.roles.manage      roles.manage

branches.view           branches.manage          settings.view       settings.manage
audit.view              notifications.view       notifications.create
```

`members.view_directory` is a deliberate, separate permission. An usher marking attendance
needs to find "Grace Mensah" and see her photo; she should not thereby expose her home
address, date of birth, and occupation to whoever is on the door. It grants read on a narrow
view — `member_directory(id, member_no, full_name, photo_path, branch_id)` — and nothing else.

### 7.3 Scoping

Three scope kinds, resolved in this order:

1. **Global** — `user_roles.branch_id IS NULL` → permission applies in every branch.
2. **Branch** — `user_roles.branch_id = X` → permission applies only in branch X.
3. **Ownership / leadership** — computed, never granted:
   - Ministry leaders: `ministry_members.role_in_ministry = 'leader'` on that ministry.
   - Members: `members.user_id = auth.uid()` for their own record.

### 7.4 Draft role → permission matrix

This is a **proposal derived from the role descriptions in §11 of the brief**, not from your
church's actual policy. It is the single thing most likely to be wrong, so please correct it
(Q1). `✓` = granted, `own` = restricted by scope.

| Permission group                  | Super Admin | Senior Pastor | Finance Officer | Elder | Secretary | Ministry / Choir Leader | Media            | Usher        | Member               | Guest       |
| --------------------------------- | ----------- | ------------- | --------------- | ----- | --------- | ----------------------- | ---------------- | ------------ | -------------------- | ----------- |
| members.view                      | ✓           | ✓             | —               | ✓     | ✓         | own ministry            | —                | —            | own                  | —           |
| members.view_directory            | ✓           | ✓             | ✓               | ✓     | ✓         | ✓                       | ✓                | ✓            | —                    | —           |
| members create/update             | ✓           | ✓             | —               | —     | ✓         | —                       | —                | —            | own (limited fields) | —           |
| members.delete                    | ✓           | —             | —               | —     | —         | —                       | —                | —            | —                    | —           |
| families.*                        | ✓           | view          | —               | view  | ✓         | —                       | —                | —            | own                  | —           |
| ministries.*                      | ✓           | ✓             | —               | view  | view      | own                     | —                | —            | view                 | —           |
| attendance.record                 | ✓           | ✓             | —               | —     | ✓         | own ministry            | —                | ✓            | —                    | —           |
| attendance.view                   | ✓           | ✓             | —               | ✓     | ✓         | own ministry            | —                | own sessions | own                  | —           |
| events create/update              | ✓           | ✓             | —               | —     | ✓         | own ministry            | ✓ (media fields) | —            | —                    | —           |
| events.view                       | ✓           | ✓             | ✓               | ✓     | ✓         | ✓                       | ✓                | ✓            | ✓                    | public only |
| finance.view / create / update    | ✓           | view          | ✓               | —     | —         | —                       | —                | —            | —                    | —           |
| finance.submit                    | ✓           | —             | ✓               | —     | —         | —                       | —                | —            | —                    | —           |
| finance.approve / reject / void   | ✓           | ✓             | —               | —     | —         | —                       | —                | —            | —                    | —           |
| reports.finance.view              | ✓           | ✓             | ✓               | —     | —         | —                       | —                | —            | —                    | —           |
| users.* / roles.manage            | ✓           | view          | —               | —     | view      | —                       | —                | —            | —                    | —           |
| audit.view                        | ✓           | ✓             | —               | —     | —         | —                       | —                | —            | —                    | —           |
| settings.manage / branches.manage | ✓           | —             | —               | —     | —         | —                       | —                | —            | —                    | —           |

### 7.5 Enforcement in the database

Helper functions in the `app` schema, `SECURITY DEFINER`, `STABLE`:

```
app.current_member_id()                      → uuid
app.has_permission(perm text)                → boolean   -- in any accessible branch
app.has_permission_in(perm text, br uuid)    → boolean
app.accessible_branch_ids()                  → setof uuid
app.is_ministry_leader(min uuid)             → boolean
```

Policies call them wrapped in a scalar subquery — `using ( (select app.has_permission_in('members.view', branch_id)) )` — so PostgreSQL evaluates the permission lookup once per query as an InitPlan rather than once per row. That detail is the difference between a fast and an unusable members list.

For Phase 4 we use live table lookups (always correct, slightly slower). Supabase's Custom
Access Token Hook can later push the role into the JWT to remove the lookup; note the
documented trade-off — **role changes then don't take effect until the next token is issued**,
while permission changes still apply immediately. We treat that as a later optimisation, not
part of the MVP.

---

## 8. SECURITY ARCHITECTURE

### 8.1 Threat → control

| Threat (§28)                  | Control                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL injection                 | No SQL strings are ever concatenated. All access via PostgREST/`supabase-js`, which parameterizes. The few `SECURITY DEFINER` functions use `format(%I/%L)` or take no dynamic identifiers                                                                                                                                  |
| XSS                           | Strict CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`. No inline scripts/styles, no CDN. All DOM writes go through `textContent` or an escaping helper; `innerHTML` is banned by an ESLint rule |
| Token theft via XSS           | Credentials are in `HttpOnly` cookies; JS cannot read them                                                                                                                                                                                                                                                                  |
| CSRF                          | Cookies are `SameSite` + double-submit CSRF token on every state-changing request + `Origin`/`Sec-Fetch-Site` check. Rejects on mismatch before any handler runs                                                                                                                                                            |
| Broken authentication         | Supabase Auth; no custom password code; uniform login errors; refresh-token revocation on logout and deactivation                                                                                                                                                                                                           |
| Broken authorization          | Two independent layers: API `withPermission` and RLS. Every table has RLS enabled with an explicit policy per operation; a table with RLS on and no policy denies by default                                                                                                                                                |
| IDOR / BOLA                   | No handler trusts a client-supplied `branch_id` for reads. Row visibility is decided by RLS from `auth.uid()`, so a guessed UUID returns 404, not data. Authz-matrix tests assert exactly this                                                                                                                              |
| Privilege escalation          | `user_roles` writes require `users.roles.manage`; a trigger blocks granting a permission the grantor does not itself hold, and blocks self-granting `super_admin`. The last active super-admin cannot be deactivated                                                                                                        |
| Insecure uploads              | Server-side magic-byte sniffing, extension allow-list (`jpg/jpeg/png/webp` for images, `+pdf` for receipts), size cap, UUID filename, client path discarded, private buckets, `Content-Disposition: attachment` on documents. Executables and SVG are rejected (SVG carries script)                                         |
| Exposed secrets               | Service-role key exists only in Vercel env vars and `.env.local` (gitignored). `.env.example` holds names only. Pre-commit secret scan. The browser bundle contains **no** Supabase credentials at all                                                                                                                      |
| Insecure API endpoints        | Deny-by-default router: a route with no declared permission fails to register. Rate limits on auth endpoints                                                                                                                                                                                                                |
| Insecure database access      | Default client is user-scoped (RLS applies). Service-role usage is import-restricted, allow-listed, and logged                                                                                                                                                                                                              |
| Mass assignment               | zod schemas are `.strict()`; unknown keys are rejected, not ignored. Write-allow-lists per role for sensitive fields (a member cannot edit their own `membership_status`)                                                                                                                                                   |
| Enumeration / brute force     | Postgres-backed sliding-window limiter on `/api/auth/*` (per IP + per email) on top of Supabase Auth's own limits                                                                                                                                                                                                           |
| Information leakage in errors | Single error mapper: internal detail goes to the log with a `requestId`; the client gets `{ code, message, requestId }`. No stack traces, no PG error text, no paths (§37)                                                                                                                                                  |

Response headers on all routes: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`,
`Permissions-Policy` (camera/mic/geo off), plus the CSP above. CORS is **not** enabled —
the API is same-origin only, which removes an entire class of misconfiguration.

### 8.2 Data protection posture

Member records contain personal data on identifiable individuals, and possibly on minors
(`family_members.is_dependent`). Concretely: private storage buckets, no PII in logs or
audit `changes` payloads beyond record identifiers, `members.export` as its own permission
(bulk extraction is a distinct act from viewing), soft delete so records can be restored,
and TLS everywhere. Jurisdiction-specific obligations depend on Q7 — I have not assumed a
legal regime.

---

## 9. VERCEL DEPLOYMENT ARCHITECTURE

### 9.1 Project settings

| Setting          | Value                                  | Note                                                       |
| ---------------- | -------------------------------------- | ---------------------------------------------------------- |
| Framework preset | Other                                  | No build step                                              |
| Build command    | _(none)_                               | Static assets served as-is                                 |
| Output directory | `public`                               |                                                            |
| Node.js version  | 24.x                                   | Vercel default; matches your local v24.16.0 (verified)     |
| Function region  | matched to the Supabase project region | Default is `iad1`; a mismatch costs latency on every query |

### 9.2 `vercel.json` (shape only — not yet written)

```jsonc
{
  "cleanUrls": true,
  "trailingSlash": false,
  "rewrites": [{ "source": "/api/(.*)", "destination": "/api/index" }],
  "headers": [/* CSP + security headers; long cache for /assets/*, no-store for /api/* */],
  "functions": { "api/index.js": { "maxDuration": 15 } },
}
```

The single rewrite is what keeps us at one function and clear of the Hobby 12-function cap.
Function duration: for projects created after April 2025, Fluid compute is the default and
the duration ceiling differs from the legacy table (legacy non-Fluid: Hobby 10 s default /
60 s max, Pro 15 s / 300 s). I will confirm the actual ceiling on your plan in the dashboard
before setting `maxDuration` — I am not going to guess a number into a config file.

### 9.3 Pre-deployment checklist (§33)

Runtime version · build config · env vars present in the right scope · rewrites resolve ·
`/api/health` responds · Supabase reachable from the function region · login round-trip works ·
signed storage URL resolves · CORS intentionally absent · security headers present ·
Supabase Auth redirect allow-list includes production and preview URLs.

### 9.4 Environment variables

| Name                        | Scope  | Exposed to browser |
| --------------------------- | ------ | ------------------ |
| `SUPABASE_URL`              | server | no                 |
| `SUPABASE_ANON_KEY`         | server | no                 |
| `SUPABASE_SERVICE_ROLE_KEY` | server | **never**          |
| `APP_URL`                   | server | no                 |
| `SESSION_COOKIE_PREFIX`     | server | no                 |
| `LOG_LEVEL`                 | server | no                 |

There is **no client-exposed variable list**, and no `NEXT_PUBLIC_`-style prefix in this
project — a nice property of the BFF: the class of "we leaked a key into the bundle" bug is
structurally impossible. `src/config/env.js` validates every variable at cold start and
throws immediately if one is missing, so a misconfiguration fails at deploy, not at 2 a.m.

---

## 10. DEVELOPMENT PHASES

Mapped to §41, with the exit criteria from §36. Estimates are working-session sizes, not
calendar promises.

| #   | Phase                 | Deliverables                                                                                                                                     | Exit criteria                                                         | Size |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---- |
| 1   | Foundation            | repo, Git, `.gitignore`, folder skeleton, env validation, `/api/health`, router + middleware chain, design tokens, base shell, login page markup | health endpoint returns 200 locally; CSP passes; no secrets in Git    | S    |
| 2   | Database              | migrations 0001–00NN, enums, constraints, indexes, `app.*` helpers, RLS on every table, seed roles/permissions                                   | `supabase db reset` rebuilds clean; pgTAP suite green                 | L    |
| 3   | Authentication        | login/logout/session/refresh/reset, cookie handling, CSRF, protected-page gating                                                                 | manual + integration tests for all flows; deactivated user locked out | M    |
| 4   | Authorization         | permission resolver, `withPermission`, RLS policy completion, authz-matrix test harness                                                          | matrix test covers every role × endpoint                              | M    |
| 5   | Members               | CRUD, photo upload, search (GIN), filters, pagination, detail page                                                                               | quality gates §36                                                     | L    |
| 6   | Families              | families + relationships + household view                                                                                                        | quality gates                                                         | M    |
| 7   | Ministries            | ministries, leaders, membership, ministry-scoped authz                                                                                           | leader scope proven by test                                           | M    |
| 8   | Attendance            | sessions, recording, member history, statistics                                                                                                  | quality gates                                                         | L    |
| 9   | Events                | events, categories, calendar, registrations, event attendance                                                                                    | quality gates                                                         | M    |
| 10  | Finance               | transactions, categories, void, receipts, financial reports                                                                                      | authz tests prove non-finance roles get 403 **and** empty RLS reads   | L    |
| 11  | Reporting             | role-specific dashboards, reports with filters + date ranges + CSV export                                                                        | no report loads unbounded rows                                        | L    |
| 12  | Audit & notifications | audit writer + viewer, notifications + unread badge                                                                                              | audit rows immutable (proven by test)                                 | M    |
| 13  | Security & QA         | full authz sweep, validation fuzz, regression, `EXPLAIN` review of hot queries                                                                   | documented findings, all criticals closed                             | M    |
| 14  | Production            | prod Supabase, Vercel env, domain, backups, monitoring, smoke tests                                                                              | verified deployment                                                   | M    |

Each phase ends with the report format from §42 (Completed / Files / Database / Security /
Testing / Remaining / Next) and a commit series using the §32 conventions.

---

## 11. MVP FEATURE LIST

**In scope**

- Auth: login, logout, session, password reset, admin invitations, account deactivation
- RBAC: 11 roles, ~48 permissions, branch scoping, ministry-leader scoping, role admin UI
- Members: CRUD, photo, emergency contacts, spiritual gifts, search, filter, paginate, soft delete
- Families: households, membership, relationships, one-head rule
- Ministries: CRUD, leaders, membership with history
- Attendance: service / event / ministry sessions, manual + search entry, per-member history, statistics
- Events: CRUD, categories, calendar month view, registrations, event attendance
- Finance: income (tithe/offering/donation/other) + expenses, categories, receipts, **submit → approve/reject workflow on every transaction (D3)**, approval queue, void-not-delete, financial reports over approved rows only
- Member self-service (D4): own profile, own attendance history — no giving history
- Reports: member, new-member, attendance, ministry, event, income, expense — filters, date ranges, pagination, CSV export
- Dashboards: role-specific widgets, nothing rendered the role cannot see
- Notifications: in-app system/announcement/reminder + unread badge
- Audit: immutable log + viewer
- UI: responsive mobile-first, light/dark/system theme, empty/loading/error/success states, confirm dialogs, keyboard-navigable, labelled forms
- Docs: README, ARCHITECTURE, DATABASE, SECURITY, DEPLOYMENT, API, RBAC, DECISIONS

**Explicitly out of scope for the MVP** (architecture leaves room for each)

Email/SMS delivery (§21 says wait) · QR-code attendance (schema has `method='qr'`, no scanner) ·
RFID (§16) · online giving / payment gateways · pledges, budgets, double-entry accounting ·
member self-service portal beyond own profile · multi-church SaaS tenancy · PDF/Excel export
(CSV only) · offline mode · public website · sermon/media library.

---

## 12. POTENTIAL RISKS

| #   | Risk                                                        | Impact                                                              | Mitigation                                                                                                  |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | **Git is not installed on this machine** (verified)         | §32 cannot start; no version control                                | Install Git for Windows before Phase 2 — hard prerequisite, still outstanding (Q11)                         |
| 2   | **Docker is not installed** (verified)                      | `supabase start` cannot run → no local DB, no pgTAP, no offline dev | **Resolved by D8** — Docker Desktop to be installed; blocks Phase 2 until then                              |
| 3   | Function/database region mismatch                           | +100–250 ms on every query, felt on every page                      | Decide the region pair before creating the Supabase project (Q7)                                            |
| 4   | Hobby 12-function cap (verified)                            | Deployment failure once the API grows                               | Single-function router from day one                                                                         |
| 5   | Service-role key misuse creeping in                         | Silent, total RLS bypass                                            | Import allow-list enforced by ESLint; separate module; code-review checklist item                           |
| 6   | Cookie-refresh races in a concurrent serverless environment | Sporadic logouts                                                    | Refresh only on the dedicated session endpoint; client retries once on 401; short clock-skew tolerance      |
| 7   | RLS policies that re-evaluate per row                       | Members list becomes slow at ~10k rows                              | `(select app.has_permission(...))` wrapping; `EXPLAIN ANALYZE` review in Phase 13                           |
| 8   | Financial rules guessed rather than specified               | Wrong money handling — the most damaging possible defect            | Q4 blocks Phase 10; nothing financial is invented                                                           |
| 9   | No build step → no bundling                                 | More HTTP requests; manual cache-busting                            | HTTP/2 multiplexing makes this acceptable; hashed query strings for cache-busting; revisit only if measured |
| 10  | Supabase free-tier projects pause after inactivity          | Dev environment appears broken                                      | Known behaviour; production must be on a plan that does not pause                                           |
| 11  | Timezone confusion in attendance/events                     | Wrong-day records                                                   | All `timestamptz`; church timezone in `branches.timezone`; dates rendered in branch-local time              |
| 12  | Soft delete vs unique constraints                           | "Email already exists" for a deleted member                         | Partial unique indexes with `where deleted_at is null`                                                      |
| 13  | Role matrix in §7.4 is my inference                         | Users see too much or too little                                    | Q1 — please correct it before Phase 4                                                                       |
| 14  | Vendored Bootstrap needs manual updates                     | Missed security patches                                             | Version pinned in `package.json`, refresh script, checked at each phase review                              |

---

## 13. DEPENDENCIES REQUIRED

**Runtime (2)**

| Package                 | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `@supabase/supabase-js` | Auth + PostgREST + Storage client (server-side only)     |
| `zod`                   | Request validation and type coercion at the API boundary |

**Development**

| Package / tool          | Purpose                                                 |
| ----------------------- | ------------------------------------------------------- |
| `supabase` (CLI)        | local stack, migrations, `supabase test db` (pgTAP)     |
| `vercel` (CLI)          | `vercel dev`, env pull, deploys                         |
| `eslint` + `@eslint/js` | lint, plus the import and `innerHTML` restrictions      |
| `prettier`              | formatting                                              |
| `@playwright/test`      | E2E smoke tests (login, member CRUD, permission denial) |

**Vendored, not npm-runtime**: Bootstrap 5.3 CSS/JS + Bootstrap Icons, copied into
`public/assets/vendor/` and version-pinned.

**Deferred**: Chart.js — only if the dashboard needs real charts in Phase 11; a first pass
can use accessible CSS/SVG bars with no dependency. Your call at that point.

Nothing else. No ORM, no HTTP framework, no state manager, no date library
(`Intl.DateTimeFormat` covers formatting), no logging library (structured `console.log` with
a request id is sufficient in Vercel's log pipeline).

---

## 14. DEVELOPMENT ENVIRONMENT REQUIREMENTS

Checked on this machine, 2026-08-26:

| Requirement           | Status                                          | Action                                          |
| --------------------- | ----------------------------------------------- | ----------------------------------------------- |
| Node.js 24.x          | **v24.16.0 present** — matches Vercel's default | none                                            |
| npm 11                | **v11.13.0 present**                            | none                                            |
| Git                   | **NOT INSTALLED**                               | install Git for Windows; required by §32        |
| Docker Desktop        | **NOT INSTALLED**                               | needed for the local Supabase stack — see Q8    |
| VS Code               | present                                         | optional: ESLint, Prettier, Supabase extensions |
| GitHub CLI (`gh`)     | not installed                                   | optional convenience                            |
| Supabase account      | unknown                                         | needed: dev/staging + production projects       |
| Vercel account        | unknown                                         | needed: linked to the GitHub repo               |
| GitHub account + repo | unknown                                         | needed                                          |

Local workflow once set up: `supabase start` (local Postgres/Auth/Storage) + `vercel dev`
(static assets + the API function) → app at `http://localhost:3000` with a local database
and no cloud dependency.

---

## 15. OPEN QUESTIONS

**Resolved 2026-08-26:** core architecture (D1), Q2 multi-branch (D2), Q4a approval workflow (D3),
Q6 member logins (D4), Q3 attendance (D5), Q4b finance approvers (D6), Q5 member fields (D7),
Q8 local database (D8).

### Blocking — needed before the phase shown

| #   | Question                                                                                      | Blocks   | My recommendation if you have no preference                                |
| --- | --------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| Q1  | Is the role → permission matrix in §7.4 correct for **your** church? Corrections to any cell. | Phase 4  | use as drafted (now reflecting D6), then adjust                            |
| Q4c | What **currency**, and does the system need more than one?                                    | Phase 10 | single currency, set once in `settings`; no default guessed                |
| Q4d | Must a tithe always be attributed to a named member, or are **anonymous tithes** allowed?     | Phase 10 | offerings anonymous by default; tithes optionally attributed, not required |

### Non-blocking — needed before Phase 14

| #   | Question                                                                                            |
| --- | --------------------------------------------------------------------------------------------------- |
| Q7  | Country / region for the Supabase project (drives latency, and any data-protection obligations)?    |
| Q9  | Church name, branch name(s), and a logo, for the seed data and UI shell?                            |
| Q10 | Do you already have Supabase / Vercel / GitHub accounts, or should we walk through creating them?   |
| Q11 | Git is not installed on the build machine — install it before Phase 2 so the work can be committed. |

### Non-blocking — needed before Phase 14

| #   | Question                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q7  | Country / region for the Supabase project (drives latency, and any data-protection obligations)?                                                                                          |
| Q8  | Install Docker Desktop for a local Supabase stack, or work against a cloud dev project? Docker is strongly preferred — it is what makes pgTAP RLS tests and offline development possible. |
| Q9  | Church name, branch name(s), and a logo, for the seed data and UI shell?                                                                                                                  |
| Q10 | Do you already have Supabase / Vercel / GitHub accounts, or should Phase 1 include walking through creating them?                                                                         |

---

## 16. VERIFIED VS ASSUMED

Being explicit, per §44.

**Verified against vendor documentation on 2026-08-26**

- Vercel Node.js runtime versions: 24.x (default), 22.x, 20.x.
- Vercel Hobby limit: without a framework, every file in `api/` becomes one function, capped at **12 per deployment**.
- Vercel functions default to region `iad1`; single region on Hobby.
- Legacy (non-Fluid) function duration: Hobby 10 s default / 60 s max; Pro 15 s / 300 s. New projects default to Fluid compute, where the ceiling differs — to be confirmed in the dashboard.
- Vercel env vars: 64 KB total per deployment; scoped per environment.
- Supabase RBAC pattern: `user_roles` + `role_permissions`, a `SECURITY DEFINER` `authorize()` helper, and the Custom Access Token Hook — including the documented caveat that **role** changes do not reach the JWT until a new token is issued, while **permission** changes take effect immediately.

**Verified on this machine**

- `D:\PY\update` is empty; Node v24.16.0; npm 11.13.0; VS Code present; **Git, Docker, and `gh` are not installed**.

**Assumed / not yet verified — will be confirmed before it matters**

- Exact Fluid-compute `maxDuration` ceiling on your Vercel plan.
- That `vercel.json` rewrites to a single `api/index` function behave as expected for all HTTP methods (Phase 1 will prove this with `/api/health` before anything is built on top).
- Supabase Storage policy syntax details for path-prefix rules.
- Every business rule marked in §15 as an open question.

**Not done:** no code written, no dependency installed, no repository created, no Supabase project created, nothing deployed, nothing tested.

---

## APPROVAL REQUESTED

Please respond with either:

1. **Approved** — and answers to Q1–Q6 (Q7–Q10 can follow), then I begin **Phase 1 — Foundation**; or
2. **Changes** — tell me which sections to revise, and I will update this blueprint before writing any code.
