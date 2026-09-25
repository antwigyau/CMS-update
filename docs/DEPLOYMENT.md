# Deployment

Nothing in this document has been executed. It is the procedure to follow, written
from the configuration actually in the repository — not a report of a deployment
that happened. Every step that cannot be verified from here is marked.

- [Prerequisites](#prerequisites)
- [1. Supabase project](#1-supabase-project)
- [2. Auth configuration](#2-auth-configuration)
- [3. Vercel project](#3-vercel-project)
- [4. First deploy](#4-first-deploy)
- [5. Bootstrap the first administrator](#5-bootstrap-the-first-administrator)
- [6. Verification checklist](#6-verification-checklist)
- [Environments](#environments)
- [Rollback](#rollback)

---

## Prerequisites

| Tool             | Why                                                              | Status on the build machine |
| ---------------- | ---------------------------------------------------------------- | --------------------------- |
| Node.js 24.x     | Matches Vercel's default runtime                                 | ✅ v24.16.0                 |
| Supabase CLI     | Migrations, local stack                                          | ✅ v2.115.0 (devDependency) |
| Git              | Vercel deploys from a repository                                 | ❌ **not installed**        |
| Docker Desktop   | `supabase start`, and verifying the schema against real Supabase | ❌ **not installed**        |
| GitHub account   | Vercel's Git integration                                         | not confirmed               |
| Supabase account | Two projects: staging and production                             | not confirmed               |
| Vercel account   | Hobby is sufficient to start                                     | not confirmed               |

Git is a hard blocker: no commit exists yet, so there is nothing for Vercel to
deploy.

---

## 1. Supabase project

**Region matters more than it looks.** Vercel Functions default to `iad1`
(Washington, D.C.). If the Supabase project sits elsewhere, every database round
trip pays 100–250 ms — on every page, forever. Pick the pair deliberately:

- choose the Supabase region closest to the congregation, then
- set the Vercel function region to match (Project → Settings → Functions).

Then, from a checkout with the CLI available:

```powershell
npx supabase link --project-ref <project-ref>
npm run db:push          # applies supabase/migrations in order
npx supabase db execute --file supabase/seed.sql
```

`db:push` is forward-only and idempotent per migration. The seed is idempotent, so
running it twice is safe — asserted by a test.

Confirm afterwards:

```sql
select count(*) from public.permissions;   -- expect 55
select count(*) from public.roles;         -- expect 11
select count(*) from pg_policies where schemaname = 'public';  -- expect 68
```

**Not yet verified:** these migrations have only ever been applied to PGlite with
Supabase shims (ADR-019). The first `db:push` is the real test. Do it against
staging first.

---

## 2. Auth configuration

In the Supabase dashboard, under **Authentication**:

**Providers → Email.** Enable email sign-in. Disable "Enable email signups" —
accounts are created by administrators (decision D4), and open sign-up on a system
holding member data is an attack surface with no owner.

**URL Configuration.** Set the Site URL to the production URL, and add every
preview URL pattern to the Redirect URLs allow-list. A URL that is not on the list
silently fails to redirect, which looks like a broken email link.

**Email Templates → Reset Password.** This one is required, and easy to miss. The
default template links to `{{ .ConfirmationURL }}`, which does not reach our API.
Change the link to:

```html
<a href="{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&type=recovery">
  Reset your password
</a>
```

Our `/reset-password` page reads `token_hash` from the query string and posts it to
`POST /api/auth/password/reset`, which exchanges it server-side via `verifyOtp`.
The browser never receives a Supabase credential.

**Until this template is changed, password reset will not work.** The API side is
implemented and tested against a fake provider; this is the half that lives in the
dashboard.

**Sessions.** Note the access token lifetime (default 1 hour). `buildSessionCookies`
keeps the access cookie alive slightly longer than the token so a refresh is still
possible — if you shorten the token lifetime dramatically, re-read that code.

---

## 3. Vercel project

Import the Git repository, then:

| Setting          | Value                                   |
| ---------------- | --------------------------------------- |
| Framework preset | **Other**                               |
| Build command    | `npm run vendor:refresh`                |
| Output directory | `public`                                |
| Install command  | `npm install` (default)                 |
| Node.js version  | 24.x (from `engines` in `package.json`) |
| Function region  | matched to the Supabase region          |

Environment variables, scoped per environment — Preview must **never** point at
production:

| Name                        | Production                             | Preview         |
| --------------------------- | -------------------------------------- | --------------- |
| `SUPABASE_URL`              | production project                     | staging project |
| `SUPABASE_ANON_KEY`         | production                             | staging         |
| `SUPABASE_SERVICE_ROLE_KEY` | production                             | staging         |
| `APP_URL`                   | `https://<domain>` — no trailing slash | the preview URL |
| `SESSION_COOKIE_PREFIX`     | `cma`                                  | `cma`           |
| `LOG_LEVEL`                 | `info`                                 | `debug`         |

`APP_URL` is validated at cold start and is used for the CSRF `Origin` check. A
wrong value does not fail quietly — it rejects every state-changing request.

`vercel.json` is already in the repository and needs no editing. It rewrites
`/api/(.*)` to the single function, sets the security headers, and caches assets
for ten minutes.

**`maxDuration` is deliberately not set.** New projects default to Fluid compute,
whose ceiling differs from the legacy table, and the value on your plan should be
read from the dashboard rather than guessed into a config file.

---

## 4. First deploy

Push to the default branch, or `npx vercel --prod`.

Then check the boot log. `assertDeployedConfig()` runs at cold start and throws if
any Supabase variable is missing, so a misconfiguration appears here rather than on
a user's first sign-in.

---

## 5. Bootstrap the first administrator

The system has no self-registration and no seeded user, which means the first
account has to be created deliberately. This is a one-time manual step.

1. **Authentication → Users → Add user** in the Supabase dashboard. Set an email
   and a password, and mark the email confirmed.
2. Note the new user's UUID, then run:

```sql
insert into public.profiles (id, full_name, is_active)
values ('<user-uuid>', '<Full Name>', true);

insert into public.user_roles (user_id, role_id)
select '<user-uuid>', r.id from public.roles r where r.key = 'super_admin';
```

The `branch_id` is left NULL, which grants the role in every branch.

Note what the escalation guards do and do not do here: they stand aside when there
is no JWT, so this SQL works. They apply to every subsequent grant made through the
application, including the rule that nobody may edit their own grants — which is
why the first administrator cannot be created by the application itself.

**Create a second administrator before going live.** The last active
`super_admin` grant cannot be removed, and finance approval requires a second
person (decision D6): with one account, the approval queue cannot be cleared.

3. Replace the placeholder settings:

```sql
update public.settings set value = '"<Church Name>"'::jsonb where key = 'church.name';
update public.settings set value = '"GHS"'::jsonb where key = 'finance.currency';
update public.branches set code = '<CODE>', name = '<Branch Name>' where code = 'MAIN';
```

`finance.currency` is seeded **unset on purpose**. Finance must refuse to record a
transaction until it is set, because a guessed currency produces a ledger that is
quietly wrong. Changing the branch `code` changes the prefix of _future_ member
numbers only; existing ones are immutable.

---

## 6. Verification checklist

Run through this on the deployment, not on localhost. Nothing below has been
performed yet.

**Platform**

- [ ] `GET /api/health` returns 200 with `deployment: "production"`
- [ ] The `/api/(.*)` rewrite resolves — this is the one behaviour that could not be verified locally (ADR-002). Check which branch of `resolvePath()` fires by looking at a log line's `path` field
- [ ] Static assets load; `Cache-Control` is 10 minutes on `/assets/*` and `no-store` on `/api/*`
- [ ] Security headers present on both a document and an API response
- [ ] No CSP violation in the browser console on any page

**Database**

- [ ] Migration count matches `supabase/migrations`
- [ ] Counts from step 1 match
- [ ] Supabase **Advisors** report no errors — this checks things the local harness cannot, including definer views and exposed schemas

**Authentication**

- [ ] Sign in as the bootstrap administrator
- [ ] `GET /api/health/deep` returns 200 for them and 403 for an account without `settings.view`
- [ ] Cookies in the browser: `cma_at` and `cma_rt` are HttpOnly and Secure; `cma_rt` has `Path=/api/auth`; `cma_csrf` is readable
- [ ] Sign out clears all three
- [ ] Wrong password and unknown email give identical responses
- [ ] Password reset: request it, receive the email, confirm the link carries `token_hash`, complete it, sign in with the new password

**Authorization**

- [ ] Create a second user with a narrow role and confirm the navigation and the API both refuse what they should
- [ ] Confirm a member cannot change their own `membership_status` through the API

---

## Environments

| Environment | Supabase                  | Vercel              | Purpose                     |
| ----------- | ------------------------- | ------------------- | --------------------------- |
| Local       | `supabase start` (Docker) | `npm run dev`       | Development, database tests |
| Staging     | staging project           | Preview deployments | QA, migration rehearsal     |
| Production  | production project        | Production          | Live                        |

Apply every migration to staging first. A migration is forward-only: there is no
`down`, by design, because a partially-applied rollback on live data is worse than
a forward fix.

---

## Rollback

**Application.** Vercel keeps previous deployments; promote the last good one. The
frontend and the API deploy together, so this is a single action.

**Database.** There is no automatic rollback. A bad migration is corrected with a
new migration. Before any destructive schema change, take a backup from the
Supabase dashboard — and remember that the application code currently deployed may
expect the old shape, so order matters: deploy tolerant code first, migrate second.

**Backups.** Supabase's automatic backups depend on the plan. Confirm the retention
period before going live rather than after; a church's financial records and
membership roll are not reconstructible from anywhere else.
