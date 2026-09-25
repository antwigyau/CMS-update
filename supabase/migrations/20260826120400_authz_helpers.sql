-- ============================================================================
-- 0004 · Authorization helpers
-- ----------------------------------------------------------------------------
-- The functions RLS policies call. Design notes:
--
-- SECURITY DEFINER, because a policy on `members` must be able to read
--   `user_roles` and `permissions` without the caller needing select rights on
--   them — and without those tables' own policies recursing into this one.
--
-- STABLE, and always invoked from policies as `(select app.has_permission(...))`.
--   Wrapped in a scalar subquery, PostgreSQL evaluates it once per query as an
--   InitPlan instead of once per row. On a 20k-row members table that is the
--   difference between a fast list and an unusable one.
--
-- `set search_path = ''` with fully qualified names, so a caller who can create
--   objects cannot shadow a table name and have a definer-privileged function
--   read theirs instead.
--
-- Every function checks `profiles.is_active`. Deactivating a user therefore
-- removes their database access as well as their session, without touching a
-- single grant.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

create or replace function app.current_user_id() returns uuid
language sql
stable
set search_path = ''
as $$
  select auth.uid();
$$;

comment on function app.current_user_id() is
  'The calling user, or NULL when unauthenticated. Single point of change.';

create or replace function app.is_active_user() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.is_active
  );
$$;

-- ---------------------------------------------------------------------------
-- Permission checks
-- ---------------------------------------------------------------------------

-- Does the caller hold this permission anywhere at all?
--
-- Use this only for genuinely global concerns (settings, roles, audit). For
-- anything with a branch_id, use has_permission_in — otherwise a user granted a
-- role in branch A could act on branch B's rows.
create or replace function app.has_permission(p_permission text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.profiles pr on pr.id = ur.user_id
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions pe on pe.id = rp.permission_id
    where ur.user_id = auth.uid()
      and pr.is_active
      and pe.key = p_permission
  );
$$;

-- Does the caller hold this permission in this branch?
-- A grant with branch_id IS NULL applies in every branch.
create or replace function app.has_permission_in(p_permission text, p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.profiles pr on pr.id = ur.user_id
    join public.role_permissions rp on rp.role_id = ur.role_id
    join public.permissions pe on pe.id = rp.permission_id
    where ur.user_id = auth.uid()
      and pr.is_active
      and pe.key = p_permission
      and (ur.branch_id is null or ur.branch_id = p_branch_id)
  );
$$;

-- Every branch the caller holds any role in. Used by the branch selector and by
-- policies on tables that have no branch_id of their own.
create or replace function app.accessible_branch_ids() returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.id
  from public.branches b
  where exists (
    select 1
    from public.user_roles ur
    join public.profiles pr on pr.id = ur.user_id
    where ur.user_id = auth.uid()
      and pr.is_active
      and (ur.branch_id is null or ur.branch_id = b.id)
  );
$$;

-- The caller's full permission set, as keys.
--
-- This exists so the API can answer "what may this user do?" without granting
-- select on `permissions`, `roles`, or `role_permissions` to anyone. The shell
-- uses it to decide which navigation items to render — cosmetically; the real
-- decision is made per request by the same tables.
create or replace function app.my_permissions()
returns table (permission_key text, branch_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct pe.key, ur.branch_id
  from public.user_roles ur
  join public.profiles pr on pr.id = ur.user_id
  join public.role_permissions rp on rp.role_id = ur.role_id
  join public.permissions pe on pe.id = rp.permission_id
  where ur.user_id = auth.uid()
    and pr.is_active;
$$;

-- ---------------------------------------------------------------------------
-- Grants
--
-- `anon` gets nothing: an unauthenticated caller has no user id, so every one
-- of these would return false or empty anyway, and policies are all scoped
-- `to authenticated`.
-- ---------------------------------------------------------------------------

grant execute on function app.current_user_id() to authenticated, service_role;
grant execute on function app.is_active_user() to authenticated, service_role;
grant execute on function app.has_permission(text) to authenticated, service_role;
grant execute on function app.has_permission_in(text, uuid) to authenticated, service_role;
grant execute on function app.accessible_branch_ids() to authenticated, service_role;
grant execute on function app.my_permissions() to authenticated, service_role;
