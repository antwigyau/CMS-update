# Database

PostgreSQL on Supabase. Every table has Row Level Security enabled and at least
one policy — asserted by a test, not by convention.

|                     |                                                                             |
| ------------------- | --------------------------------------------------------------------------- |
| Migrations          | 13, in `supabase/migrations/*.sql`, forward-only, applied in filename order |
| Tables              | 25                                                                          |
| Policies            | 68 on `public`, 15 on `storage.objects`                                     |
| Check constraints   | 76                                                                          |
| Indexes             | 106                                                                         |
| Triggers            | 28 (excluding constraint triggers)                                          |
| Roles / permissions | 11 roles, 55 permissions, 157 grants                                        |
| Tests               | 137 assertions in `tests/db/`                                               |

Regenerate these numbers with `npm run db:stats`.

## Contents

- [Entity relationships](#entity-relationships)
- [Conventions](#conventions)
- [Tables by area](#tables-by-area)
- [The authorization model](#the-authorization-model)
- [Indexes and why they exist](#indexes-and-why-they-exist)
- [Storage](#storage)
- [Running and testing](#running-and-testing)
- [Known gaps](#known-gaps)

---

## Entity relationships

```
branches ──1:N── members ──0:1── auth.users        (staff logins only; most members NULL)
    │                │
    │                ├──1:N── member_emergency_contacts
    │                ├──M:N── spiritual_gifts       via member_spiritual_gifts
    │                ├──M:N── families              via family_members  (+ relationship)
    │                ├──M:N── ministries            via ministry_members (+ role, dates)
    │                ├──1:N── attendance_records
    │                └──0:N── transactions          (nullable: anonymous offerings exist)
    │
    ├──1:N── families
    ├──1:N── ministries
    ├──1:N── events ──N:1── event_categories
    │           └──1:N── event_registrations
    ├──1:N── attendance_sessions ──1:N── attendance_records
    │           ├──0:1── ministries      (ministry-type sessions)
    │           └──0:1── events          (event-type sessions)
    └──1:N── transactions ──N:1── transaction_categories

auth.users ──1:1── profiles ──1:N── user_roles ──N:1── roles ──M:N── permissions
                                         └── branch_id (NULL = every branch)

audit_logs        append-only, no FK to the actor beyond a nullable reference
notifications ──1:N── notification_recipients ──N:1── profiles
settings          key/value, global or per-branch
```

## Conventions

Applied to every table:

| Concern                      | Convention                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary key                  | `uuid ... default gen_random_uuid()`, except `audit_logs` (`bigint identity` — ordered, cheap, and high volume)                                                   |
| Timestamps                   | `created_at` / `updated_at timestamptz not null default now()`; `updated_at` maintained by the shared `app.touch_updated_at()` trigger, never by application code |
| Money                        | `numeric(14,2)`. No float goes near an amount                                                                                                                     |
| Authorship                   | `created_by` / `updated_by` referencing `auth.users`, `on delete set null`                                                                                        |
| Tenancy                      | `branch_id` on every branch-scoped table, from the first migration (decision D2)                                                                                  |
| Deletion                     | Soft (`deleted_at`) for members; forbidden outright for `transactions` and `audit_logs`; ordinary cascade elsewhere                                               |
| Uniqueness under soft delete | Partial indexes `where deleted_at is null`, so removing a member frees their email for reuse                                                                      |

### Enum or lookup table?

A deliberate split. **Enums** where the values are fixed by the data model —
`transaction_status`, `session_type`, `membership_status`. **Lookup tables**
where the values are church policy that administrators will edit —
`transaction_categories`, `event_categories`, `spiritual_gifts`, `ministries`.
Putting the second group in enums would mean a migration every time a church
added an expense category.

## Tables by area

### Identity and access

| Table              | Purpose                                    | Notes                                                                                                                            |
| ------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `branches`         | Church branches                            | One seeded. `timezone` drives local-time display                                                                                 |
| `profiles`         | Application data for an auth user          | `is_active false` removes database access, not just the session                                                                  |
| `roles`            | 11 seeded system roles                     | `is_system` rows cannot be deleted or un-flagged (triggers)                                                                      |
| `permissions`      | 55 permission keys                         | Reference data. No write policy at all — only a migration can change it. `resource`/`action` are constrained to agree with `key` |
| `role_permissions` | Role → permission                          |                                                                                                                                  |
| `user_roles`       | The grant. `branch_id NULL` = every branch | Two partial unique indexes rather than a sentinel UUID                                                                           |
| `settings`         | Key/value, global or per-branch            | `is_public` marks settings any signed-in user may read                                                                           |

### Members

| Table                       | Notes                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `members`                   | `member_no` assigned by trigger as `<branch code>-000123`, immutable thereafter. `full_name` and `search_vector` are generated columns. Soft delete |
| `member_emergency_contacts` | Many per member, at most one primary                                                                                                                |
| `spiritual_gifts`           | Controlled list (decision D7) — so "who has the gift of teaching" is an indexed query                                                               |
| `member_spiritual_gifts`    | Join                                                                                                                                                |

Constraints worth knowing: a date of birth cannot be in the future; a baptism
date requires `is_baptized` and cannot precede birth; an email is unique per
branch among live members.

### Families

`families` + `family_members`. Two rules are enforced by partial unique index,
and both are assumptions rather than instructions — each is one dropped index
away from being relaxed:

- at most one `head` per family
- a member belongs to at most one household

`families.head_member_id` was considered and rejected: it would duplicate what
`family_members.relationship = 'head'` says, and the two would eventually
disagree.

### Ministries

`ministries` + `ministry_members`. `left_on` preserves history, so every
"current membership" index is partial on `left_on is null`. One active leader per
ministry; assistants use `role_in_ministry = 'assistant_leader'`.

Leadership is data here, not a role in `user_roles` — appointing a leader is an
ordinary edit, and their authorization scope follows automatically when the
ministry changes hands.

### Attendance (decision D5)

`attendance_sessions` carries **both** named records and headcounts:

- `attendance_records` — named individuals, which drives follow-up
- `count_adults` / `count_youth` / `count_children` / `count_visitors`, plus a
  generated `count_total` — the true total, because nobody identifies 200 people
  at the door

There is deliberately **no constraint** requiring the headcount to be at least
the named count. Ushers capture the two independently; reconciling them is a
human task, and a constraint would reject honest data entry. Reports show both.

A `CHECK` ties `session_type` to its reference: a `service` has neither ministry
nor event, a `ministry` session must name one, an `event` session must name one.

Closing a session freezes its records (trigger). Reopening one requires
`attendance.session.close`.

### Events

`event_categories`, `events`, `event_registrations`. Registration is an
intention, attendance is a fact — attendance for an event flows through
`attendance_sessions` like every other kind, so there is one attendance
mechanism rather than two to keep in step.

### Finance (decisions D3 and D6)

One `transactions` table with a `kind` discriminator, not four tables. Every
report needs both sides together, and four tables would mean four policy sets,
four validators, four approval workflows, and a `UNION` in every query.

```
draft ──submit──▶ pending_approval ──approve──▶ approved ──void──▶ void
  ▲                      │
  └──────edit──── rejected ◀──reject──┘
```

Enforced in the database, because a financial control that lives only in the API
is one bug away from not existing:

| Rule                                   | Mechanism                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Only `approved` rows count             | The `approved_transactions` view, and every report filters on it                                        |
| Valid transitions only                 | State machine in `app.guard_transaction_status()`                                                       |
| Financial details freeze on submission | Same trigger. Correcting an amount requires rejecting first, so the change is visible                   |
| Nobody approves their own entry (D6)   | `CHECK (approved_by <> submitted_by)` — the permission split alone would not stop a Super Administrator |
| Each status carries its evidence       | `CHECK` constraints requiring approver/rejecter/voider and a reason                                     |
| No deletion, ever                      | No DELETE policy for any role                                                                           |
| No guessed currency                    | `currency` is `not null` with **no default**; the application reads it from `settings`                  |

The structural half of the trigger applies even to the service-role key; only the
permission checks stand aside when there is no JWT, so a trusted backfill can
write history but still cannot create an impossible state.

### Notifications and audit

`notifications` + `notification_recipients` (in-app only, per §21 of the spec).
`link_path` must be relative, so a notification cannot be a phishing link.

`audit_logs` is append-only in the strongest form available: no UPDATE or DELETE
policy **and** triggers that raise for every role including the table owner.
Rows arrive only through `app.log_audit()`, which takes the actor from the JWT
rather than the caller, snapshots the actor's email and name so the log still
reads after a user is deleted, and redacts credential-shaped keys from the
`changes` payload.

## The authorization model

```
user → user_roles (branch-scoped or global) → roles → role_permissions → permissions
```

No role name appears in a policy or in application code. Everything asks
`app.has_permission_in('members.create', branch_id)`.

### Helper functions (`app` schema, not exposed through PostgREST)

| Function                                                                                                        | Purpose                                                                                |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `has_permission(key)`                                                                                           | Held anywhere. For genuinely global concerns only                                      |
| `has_permission_in(key, branch)`                                                                                | Held in this branch. Use this for anything with a `branch_id`                          |
| `accessible_branch_ids()`                                                                                       | Every branch the caller has a role in                                                  |
| `my_permissions()`                                                                                              | The caller's own permission set, so the API never needs to grant read on `permissions` |
| `current_member_id()`                                                                                           | The member record belonging to the caller, if any                                      |
| `can_view_member(id)` / `can_edit_member(id)`                                                                   | Defined once; child-record policies call these rather than repeating the rule          |
| `is_ministry_leader(id)`, `my_led_ministry_ids()`, `leads_ministry_of_member(id)`, `leads_session_ministry(id)` | Leadership scope                                                                       |
| `log_audit(...)`                                                                                                | The only way a row enters the audit log                                                |

All are `SECURITY DEFINER` with `set search_path = ''` and fully qualified names
— a test fails if any definer function lacks a pinned search path. All are
`STABLE` and always invoked from policies as `(select app.has_permission(...))`,
so PostgreSQL evaluates them once per query as an InitPlan rather than once per
row.

### Three scope kinds

1. **Global** — `user_roles.branch_id IS NULL`
2. **Branch** — `user_roles.branch_id = X`
3. **Ownership / leadership** — computed, never granted:
   `members.user_id = auth.uid()`, or leadership of the ministry in question

Point 3 is load-bearing. A ministry leader holds only _read_ permissions
branch-wide; everything they _do_ — managing their ministry's membership, opening
its register, marking attendance, creating its events — comes from row-level
leadership scope. Granting `ministries.members.manage` or `attendance.record`
branch-wide would let the choir leader add members to the ushering team and take
the Sunday service register. A test asserts the role holds no such grant.

### The restricted directory

`members.view_directory` is a separate permission from `members.view`, exposed
through `public.search_member_directory(branch, query, limit, offset)` — a
`SECURITY DEFINER` function returning five columns: id, member number, full
name, photo path, membership status.

An usher marking attendance needs a name and a face; they should not thereby get
home addresses, dates of birth, and occupations. The function enforces the
permission itself and caps the page size at 100 server-side. It is a function
rather than a view because a view would either apply the caller's RLS — and so
need `members.view`, defeating the purpose — or bypass it as a definer view,
which Supabase's own security advisor flags.

### Privilege escalation guards

Three rules that a `USING` clause cannot express, implemented as triggers:

- nobody may edit their own role grants — not even a Super Administrator
- nobody may grant a role carrying a permission they do not hold **in that
  scope**, so a branch administrator cannot mint a global role
- the last active Super Administrator grant cannot be removed

Plus field-level guards: a member with a login may edit their own contact
details, but not their membership status, branch, member number, `user_id` link,
or `deleted_at`.

### Cross-branch integrity

Join tables between two branch-scoped entities carry `branch_id` and use
**composite foreign keys** — `(family_id, branch_id) references families
(id, branch_id)`. A family and its members must therefore share a branch as a
matter of referential integrity, not of application discipline. Cross-branch
corruption becomes impossible rather than unlikely.

## Indexes and why they exist

| Index                                                         | Query it serves                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `members_search_idx` (GIN over `search_vector`)               | Member search, database-side. `'simple'` configuration, not `'english'` — stemming English rules over Akan or Yoruba names produces worse matches |
| `members_branch_status_idx`                                   | The filtered member list                                                                                                                          |
| `members_branch_email_key` (partial)                          | Email uniqueness among live members                                                                                                               |
| `transactions_reporting_idx` (partial, `status = 'approved'`) | Every financial report, which only ever reads approved rows                                                                                       |
| `transactions_pending_idx` (partial)                          | The approval queue, now a routine weekly task                                                                                                     |
| `attendance_records_member_idx`                               | Per-member history and the "not seen recently" report                                                                                             |
| `attendance_sessions_branch_date_idx`                         | The attendance register list                                                                                                                      |
| `events_branch_starts_at_idx`                                 | The calendar                                                                                                                                      |
| `events_upcoming_idx` (partial)                               | The dashboard widget                                                                                                                              |
| `notification_recipients_unread_idx` (partial)                | The unread badge, read on every page load                                                                                                         |
| `audit_logs_*`                                                | Filtering the log by time, resource, actor, branch, or action                                                                                     |

`notifications` has no partial index on `expires_at > now()`: `now()` is STABLE,
not IMMUTABLE, so PostgreSQL rejects it in an index predicate. (The harness
caught this.)

## Storage

Four private buckets. Reads go through short-lived signed URLs the API mints only
after checking the parent record, so a leaked URL expires.

| Bucket             | Path convention                           | Limit | Types                |
| ------------------ | ----------------------------------------- | ----- | -------------------- |
| `member-photos`    | `{branch}/{member}/{uuid}.{ext}`          | 2 MB  | jpeg, png, webp      |
| `user-avatars`     | `{user}/{uuid}.{ext}`                     | 1 MB  | jpeg, png, webp      |
| `finance-receipts` | `{branch}/{yyyy}/{mm}/{txn}/{uuid}.{ext}` | 5 MB  | jpeg, png, webp, pdf |
| `event-media`      | `{branch}/{event}/{uuid}.{ext}`           | 5 MB  | jpeg, png, webp      |

Policies on `storage.objects` key off the first path segment, parsed with
`app.try_uuid()` so a malformed path is a denial rather than an error. SVG is
excluded everywhere: it is a document format that can carry script.
`finance-receipts` has no delete policy — the transaction it supports cannot be
deleted either.

## Running and testing

```powershell
# Local stack (needs Docker Desktop)
npm run db:start          # supabase start
npm run db:reset          # rebuild the schema from migrations, then seed

# Schema tests — no Docker required
npm run test:db
```

`npm run test:db` applies every migration and the seed to **PGlite** (PostgreSQL
compiled to WebAssembly, in this process), then exercises the schema as each
role. It proves the DDL executes, the constraints bite, the triggers fire, and
the RLS policies discriminate — with Supabase's own default grants in place, so
RLS is load-bearing in the test exactly as in production.

What it does **not** cover, and what `supabase start` is for: GoTrue itself
(sign-in, tokens, password hashing, email), Supabase Storage's MIME and size
enforcement, PostgREST request handling, and Supabase's security advisors. The
full list is at the top of `tests/db/shims.sql`.

Never edit production tables by hand. Schema changes are migrations, applied with
`supabase db push`, and committed.

## Known gaps

| Gap                                                                                 | Blocked on                                                                          |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `finance.currency` is unset                                                         | Q4c. Finance must refuse to record until an administrator sets it                   |
| Branch name and code are placeholders (`MAIN` / "Main Branch")                      | Q9                                                                                  |
| Whether a tithe must always name a member                                           | Q4d. `member_id` is nullable today; the constraint is one line if the answer is yes |
| The role → permission matrix is the blueprint draft                                 | Q1. It is data, so a correction is an UPDATE                                        |
| Not yet run against real Supabase                                                   | Docker Desktop, then `supabase db reset`                                            |
| Migration `20260826121300_storage.sql` verified only against shimmed storage tables | Same                                                                                |
