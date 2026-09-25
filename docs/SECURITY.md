# Security

What is implemented, how it is verified, and what is still missing. Written to be
checked rather than believed: every claim marked **tested** has an assertion
behind it, and the gaps are listed as plainly as the controls.

- [The shape of the thing](#the-shape-of-the-thing)
- [Threats and controls](#threats-and-controls)
- [Authentication](#authentication)
- [Authorization](#authorization)
- [Secrets](#secrets)
- [Input and output](#input-and-output)
- [Known gaps](#known-gaps)
- [If something goes wrong](#if-something-goes-wrong)

---

## The shape of the thing

```
Browser ──HttpOnly cookies──▶ /api (one function) ──Supabase key──▶ Postgres + RLS
   │                                │                                    │
   no credentials                API checks permission            policy checks again
```

Two properties do most of the work:

**The browser holds no Supabase credential.** Not the anon key, not a token. There
is no client-exposed environment variable in this project at all, so the class of
bug where a key ends up in a bundle is structurally impossible rather than merely
avoided.

**Authorization is enforced twice, independently.** The API layer checks a
permission and produces a good error message. Row Level Security checks it again
in the database, where a bug in the API layer cannot reach. Neither is trusted to
be the only guard — the RLS tests deliberately verify that the database refuses
what the API would also have refused.

---

## Threats and controls

Against the list in §28 of the specification.

| Threat                        | Control                                                                                                                                                                                             | Status                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| SQL injection                 | No SQL string is ever concatenated. All access goes through PostgREST via `supabase-js`, which parameterises. `SECURITY DEFINER` functions take typed arguments and build no dynamic SQL            | **tested** — the database suite runs every query through this path                                     |
| XSS                           | Strict CSP with no `unsafe-inline` and no third-party origin. `innerHTML`, `outerHTML`, and `insertAdjacentHTML` are ESLint errors in frontend code. All text reaches the DOM through `textContent` | **tested** — a test scans every HTML file for inline script and `style=`                               |
| Session theft via XSS         | Tokens live in `HttpOnly` cookies. JavaScript cannot read them even deliberately                                                                                                                    | **tested** — cookie flags asserted                                                                     |
| CSRF                          | Double-submit token plus `Sec-Fetch-Site`/`Origin` check on every state-changing request                                                                                                            | **tested** — see ADR-024 for the pre-session exception and exactly what it exposes                     |
| Broken authentication         | Supabase Auth (GoTrue) holds the password. No custom password code exists in this repository                                                                                                        | partially tested — flows tested against a fake provider; the GoTrue round trip is **not yet verified** |
| Account enumeration           | Identical status and wording for wrong password and unknown address; a 300 ms floor on the login response; `password/forgot` always answers 202 with the same body                                  | **tested** — the two responses are compared                                                            |
| Broken authorization          | API permission check, then RLS. A route must declare `public: true` or a permission or it cannot be registered                                                                                      | **tested** — router refuses, and 137 database assertions exercise the policies                         |
| IDOR / BOLA                   | Row visibility is decided by RLS from `auth.uid()`, never from a client-supplied id or branch. A guessed UUID returns nothing                                                                       | **tested** — cross-branch reads return zero rows                                                       |
| Privilege escalation          | Nobody may edit their own grants; nobody may grant a permission they do not hold in that scope; the last active Super Administrator cannot be removed                                               | **tested** — three database tests                                                                      |
| Insecure file upload          | Private buckets, server-side MIME allow-list and size cap in Supabase Storage, path-prefix RLS policies, SVG excluded                                                                               | policies **tested** against shims; Storage's own enforcement **not yet verified**                      |
| Exposed secrets               | Service-role key only in environment variables; import-restricted by ESLint to an allow-list; `.env.local` gitignored; `.env.example` holds names only                                              | **tested** — lint rule active                                                                          |
| Insecure API endpoint         | Deny-by-default router; rate limits on auth endpoints; no CORS at all                                                                                                                               | **tested**                                                                                             |
| Mass assignment               | Every zod schema is `.strict()`, so an unknown key is a 422 rather than a silent drop. Field-level database triggers block a member editing their own status, branch, or member number              | **tested** — both layers                                                                               |
| Information leakage in errors | One mapper produces `{ code, message, requestId }`. Stack traces, database text, and filesystem paths go only to the log                                                                            | **tested** — an error body is asserted to contain no stack frame or path                               |
| Log leakage                   | The logger redacts by key name — password, token, secret, key, authorization, cookie, jwt, service_role — before writing                                                                            | **tested**                                                                                             |

Response headers on every route: `Content-Security-Policy`,
`Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy` disabling camera, microphone, geolocation, payment, and USB.
A test parses `vercel.json` and asserts it matches the JavaScript definition, so
the two copies cannot drift.

**CORS is not enabled.** The API is same-origin only, which removes an entire
class of misconfiguration rather than configuring it carefully.

---

## Authentication

| Cookie     | Contents      | Flags                                       | Readable by JS     |
| ---------- | ------------- | ------------------------------------------- | ------------------ |
| `cma_at`   | access token  | `HttpOnly; SameSite=Lax; Path=/`            | no                 |
| `cma_rt`   | refresh token | `HttpOnly; SameSite=Strict; Path=/api/auth` | no                 |
| `cma_csrf` | CSRF token    | `SameSite=Lax; Path=/`                      | **yes, by design** |

`Secure` is added whenever the app URL is https, and omitted on local http so
development can sign in.

The refresh cookie is scoped to `/api/auth`, so it is not transmitted on ordinary
API calls at all — a proxy or a logging mistake sees the short-lived access token
instead. `cma_csrf` is readable because it is not a credential: it is worthless
without the other two, and the frontend must echo it into a header.

**Refresh happens on exactly one endpoint** (ADR-022). GoTrue rotates refresh
tokens, so concurrent refreshes would invalidate each other and sign the user
out. `GET /api/auth/session` is the only route that refreshes; the client calls
it on a timer and once after a 401.

**Deactivation takes effect on the next request.** `profiles.is_active` is checked
both by the identity loader and by every database authorization helper, so a
deactivated account loses its data access as well as its session — without
touching a single grant. Tested at both layers.

**Password rules:** minimum 12 characters, no composition requirements (ADR-028).

**Sessions end on password reset.** A successful reset clears the cookies rather
than issuing new ones, so if the reset was an account recovery it also ends the
intruder's session.

---

## Authorization

```
user → user_roles (branch-scoped or global) → roles → role_permissions → permissions
```

No role name appears in a policy or in application code. Code asks
`can('finance.approve', branchId)`, never `if (role === 'finance_officer')`.
Adding a role is an INSERT, not a deployment.

Three scope kinds:

1. **Global** — a grant with `branch_id IS NULL` applies everywhere.
2. **Branch** — a grant scoped to one branch.
3. **Ownership and leadership** — computed, never granted. A member sees their own
   record because `members.user_id = auth.uid()`; a ministry leader sees their
   ministry's members because `ministry_members` says so.

Point 3 is where the sharpest lesson of the build sits. Ministry leaders hold only
_read_ permissions branch-wide; everything they _do_ comes from row-level
leadership scope. An early draft granted them `attendance.record` and
`ministries.members.manage` at branch scope, assuming the policies' leadership
branch would narrow them. It does not — policies read `permission OR leadership`,
so a branch grant subsumes the scope. The choir leader could have taken the
Sunday service register. A test caught it; a second test now asserts the role
holds none of those keys. **"OR leadership" widens, it never narrows** (ADR-020).

**Two permissions where one would do.** `members.view_directory` returns five
columns — id, member number, name, photo, status — through a function that
enforces the permission itself and caps a page at 100 rows. An usher on the door
needs a name and a face; they should not thereby get home addresses and dates of
birth.

**The second signature on money.** No one may approve a transaction they
submitted. This is not a permission check — a Super Administrator holds both
`finance.submit` and `finance.approve` — but a comparison of two actors, enforced
by the `transactions_no_self_approval` constraint. It holds even if the API has a
bug and even for the service-role key. The API mirrors it as a 403 and a
`canApprove` flag, so the Approve button is hidden from the submitter, but the
constraint is what makes it true (ADR-055). Hiding the button is cosmetic: the
endpoint, the trigger, and RLS all refuse independently.

**Only public settings reach the browser.** The session payload carries
`settings` — the church name and the transaction currency — for display. These are
`is_public` rows; the `settings_select` policy returns nothing else to a caller
without `settings.view`, so the channel cannot leak a private setting (ADR-053).

**The settings editor is a convenience, not the guard.** Reading the settings list
and writing a value both require `settings.manage`, enforced by the route table and
the `settings` RLS policies; the page's controls only decide what is drawn. A caller
who crafts the `PATCH` by hand is refused exactly as one clicking Save would be, and
the value-only schema rejects any attempt to set a `scope`, a `key`, or an actor
(ADR-063). No new gap is introduced by the admin surface.

---

## Secrets

| Variable                                        | Where it lives           | Ever sent to the browser |
| ----------------------------------------------- | ------------------------ | ------------------------ |
| `SUPABASE_URL`                                  | Vercel env, `.env.local` | no                       |
| `SUPABASE_ANON_KEY`                             | Vercel env, `.env.local` | no                       |
| `SUPABASE_SERVICE_ROLE_KEY`                     | Vercel env, `.env.local` | **never**                |
| `APP_URL`, `SESSION_COOKIE_PREFIX`, `LOG_LEVEL` | Vercel env               | no                       |

The service-role key bypasses RLS entirely, so `src/data/supabase-admin.js` is
import-restricted by an ESLint rule to an explicit allow-list. Adding a file to
that list is a deliberate, reviewable diff rather than a code-review memory test.
Legitimate uses are only those a user genuinely cannot perform as themselves:
creating auth users, writing audit rows, and cross-branch aggregate reporting.

`src/config/env.js` validates every variable at cold start and names the offending
variable — never its value — when one is wrong. `assertDeployedConfig()` makes a
deployment missing its credentials fail in the boot log rather than at 2 a.m. on
the first login.

---

## Input and output

Validation is server-side and authoritative. The frontend validates too, for a
faster correction loop, and the server never trusts it. Schemas are `.strict()`.

A 422 names the fields and says what was wrong, and never echoes the submitted
value — which matters when the field is a password. Tested.

Money is `numeric(14,2)` throughout. No float goes near an amount, and a test
asserts `0.1 + 0.2` stores as `0.30`.

**CSV exports are defended against formula injection.** A report field that begins
`=`, `+`, `-`, or `@` is prefixed with a single quote before it is written, so a
value like `=HYPERLINK(...)` in a member name is text to Excel and Sheets rather
than a formula that runs when a treasurer opens the file (OWASP's mitigation).
Tested. Every report read is also capped at 5,000 rows and refuses a wider window
rather than streaming it, so no report is an unbounded load — and every report
reads through the caller's own client, so RLS scopes the aggregate exactly as it
scopes the detail (ADR-056).

---

## Known gaps

Listed here rather than discovered later.

| Gap                                                     | Consequence                                                                                                                                                                                                                                                                                                                | Plan                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Rate limiting is in-process**                         | Vercel runs several instances, so a distributed attacker gets a multiple of the nominal limit. Supabase's own global limits still apply underneath                                                                                                                                                                         | Phase 13 — swap in the Postgres-backed store; the interface already exists (ADR-027)                                  |
| **The GoTrue round trip is unverified**                 | Sign-in, refresh, and the recovery email have been tested against a fake provider, not against Supabase                                                                                                                                                                                                                    | Needs a Supabase project. First integration run is the check                                                          |
| **The recovery email template must be changed by hand** | Until the "Reset Password" template links to `/reset-password?token_hash={{ .TokenHash }}&type=recovery`, the emailed link will not reach our endpoint                                                                                                                                                                     | Documented in `docs/DEPLOYMENT.md`; verify on first deploy                                                            |
| **Storage enforcement is unverified**                   | Member photo upload is built (signed upload/read URLs, path-prefix binding), but Supabase Storage's own MIME/size enforcement and the signed-URL wire format are tested only against a shim, not a real project (ADR-061)                                                                                                  | Needs a Supabase project                                                                                              |
| **Audit writing is best-effort**                        | `app.log_audit` is called from the mutation paths of every feature module and is readable at `/admin/audit`, but a failed audit write is logged and swallowed rather than failing the operation, so a transient error can drop one entry. Deliberate: the database, not the log, is the record's source of truth (ADR-059) | If a guaranteed trail is ever needed for a specific action, make it a table trigger rather than application code      |
| **Event capacity check races**                          | Capacity is read-then-insert, so two simultaneous registrations can both pass a near-full check and exceed the cap by one. Worst case is one extra attendee                                                                                                                                                                | Deliberate for MVP — a soft limit on a church event. Close with a trigger only if a hard cap is ever needed (ADR-052) |
| **No account lockout**                                  | Rate limiting slows guessing; it does not lock an account after N failures                                                                                                                                                                                                                                                 | Deliberate — lockout is a denial-of-service vector against a named member. Revisit if abuse is seen                   |
| **No multi-factor authentication**                      | A stolen password is enough                                                                                                                                                                                                                                                                                                | Out of MVP scope. Supabase Auth supports TOTP when wanted                                                             |
| **No penetration test**                                 | Everything here is self-assessment plus automated tests                                                                                                                                                                                                                                                                    | Phase 13 includes an authorization sweep; an external test is a separate decision                                     |
| **Session data in logs**                                | Logs carry `userId` and IP, which are personal data                                                                                                                                                                                                                                                                        | Retention is Vercel's default (1 hour Hobby, 1 day Pro). Set deliberately before production                           |

---

## If something goes wrong

**A user reports an error.** Every error response carries a `requestId`, and every
log line for that request carries the same id. Search the logs for it: the
diagnostic detail is there, and none of it was sent to the user.

**Suspected credential compromise.** Deactivate the account
(`profiles.is_active = false`) — that removes database access on the next request,
not merely the session. Then rotate the password.

**Suspected service-role key compromise.** Rotate it in the Supabase dashboard and
update the Vercel environment variable. The key is not in Git; confirm with a
history search before assuming otherwise.

**Invalidate every session at once.** Change `SESSION_COOKIE_PREFIX`. Every
existing cookie becomes unreadable and every user signs in again.
