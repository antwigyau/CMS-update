-- ============================================================================
-- 0005 · Row Level Security for identity, RBAC, and settings
-- ----------------------------------------------------------------------------
-- Supabase grants broad table privileges to `anon` and `authenticated` by
-- default, so RLS is not an extra layer here — it IS the access control. A
-- table with RLS enabled and no matching policy denies everything, which is the
-- posture we want for anything only a migration should write.
--
-- Three privilege-escalation guards are implemented as triggers rather than
-- policies, because they compare the NEW row against the actor's own rights,
-- which a USING clause cannot express:
--
--   * nobody may edit their own role grants
--   * nobody may grant a role carrying a permission they do not themselves hold
--   * the last active Super Administrator cannot be demoted
-- ============================================================================

alter table public.branches enable row level security;
alter table public.profiles enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles enable row level security;
alter table public.settings enable row level security;

-- ---------------------------------------------------------------------------
-- branches
--
-- Any signed-in user may read the branches they have a role in — the UI shows
-- branch names everywhere. Managing them is Super Administrator work.
-- ---------------------------------------------------------------------------

create policy branches_select on public.branches
  for select to authenticated
  using (
    (select app.has_permission('branches.view'))
    or id in (select app.accessible_branch_ids())
  );

create policy branches_insert on public.branches
  for insert to authenticated
  with check ((select app.has_permission('branches.manage')));

create policy branches_update on public.branches
  for update to authenticated
  using ((select app.has_permission('branches.manage')))
  with check ((select app.has_permission('branches.manage')));

-- No delete policy. A branch with history must be deactivated, not removed;
-- deleting one would cascade into member and financial records.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_select_managed on public.profiles
  for select to authenticated
  using ((select app.has_permission('users.view')));

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) or (select app.has_permission('users.update')))
  with check (id = (select auth.uid()) or (select app.has_permission('users.update')));

-- No insert policy: profiles are created by the user-provisioning service using
-- the service-role key, alongside the auth.users row. No delete policy either —
-- deletion happens by removing the auth user, which cascades.

-- A user may edit their own profile, so `is_active` needs its own guard or
-- a deactivated user could simply re-enable themselves.
create or replace function app.guard_profile_update() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new; -- service_role / migration bootstrap
  end if;

  if new.is_active is distinct from old.is_active
     and not app.has_permission('users.deactivate') then
    raise exception 'Changing account activation requires the users.deactivate permission'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger profiles_guard_update
  before update on public.profiles
  for each row execute function app.guard_profile_update();

-- ---------------------------------------------------------------------------
-- roles, permissions, role_permissions
--
-- Readable only by whoever administers roles. Everyone else learns their own
-- permissions through app.my_permissions(), which needs no table access.
-- ---------------------------------------------------------------------------

create policy roles_select on public.roles
  for select to authenticated
  using ((select app.has_permission('roles.manage')) or (select app.has_permission('users.view')));

create policy roles_write on public.roles
  for all to authenticated
  using ((select app.has_permission('roles.manage')))
  with check ((select app.has_permission('roles.manage')));

create or replace function app.guard_system_role_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.is_system and not new.is_system then
    raise exception 'Role "%" is a system role; is_system cannot be cleared', old.key
      using errcode = 'restrict_violation';
  end if;
  if old.key is distinct from new.key and old.is_system then
    raise exception 'The key of system role "%" cannot be changed', old.key
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger roles_protect_system_update
  before update on public.roles
  for each row execute function app.guard_system_role_update();

-- The permission catalogue is reference data. Read-only to everyone; only a
-- migration (running as the table owner, which bypasses RLS) can change it.
create policy permissions_select on public.permissions
  for select to authenticated
  using ((select app.has_permission('roles.manage')));

create policy role_permissions_select on public.role_permissions
  for select to authenticated
  using ((select app.has_permission('roles.manage')));

create policy role_permissions_write on public.role_permissions
  for all to authenticated
  using ((select app.has_permission('roles.manage')))
  with check ((select app.has_permission('roles.manage')));

-- ---------------------------------------------------------------------------
-- user_roles
-- ---------------------------------------------------------------------------

create policy user_roles_select_own on public.user_roles
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy user_roles_select_managed on public.user_roles
  for select to authenticated
  using ((select app.has_permission('users.view')));

create policy user_roles_insert on public.user_roles
  for insert to authenticated
  with check ((select app.has_permission('users.roles.manage')));

create policy user_roles_delete on public.user_roles
  for delete to authenticated
  using ((select app.has_permission('users.roles.manage')));

-- Deliberately no UPDATE policy: a grant is revoked and re-issued rather than
-- edited, so `granted_by` and `granted_at` always describe the grant in force.

create or replace function app.guard_role_grant() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.user_roles := coalesce(new, old);
  v_missing text;
  v_super_admins integer;
begin
  -- No JWT: this is a migration, the seed, or the user-provisioning service
  -- running with the service-role key. Those paths are trusted by design.
  if v_actor is null then
    return v_row;
  end if;

  -- Guard 1: no self-service escalation, in either direction.
  if v_row.user_id = v_actor then
    raise exception 'You cannot change your own role grants'
      using errcode = 'insufficient_privilege';
  end if;

  -- Guard 2: you cannot hand out authority you do not have. Checked per
  -- permission and per branch scope, so a branch admin cannot mint a global role.
  if tg_op = 'INSERT' then
    select pe.key into v_missing
    from public.role_permissions rp
    join public.permissions pe on pe.id = rp.permission_id
    where rp.role_id = new.role_id
      and not app.has_permission_in(pe.key, new.branch_id)
    limit 1;

    if v_missing is not null then
      raise exception
        'You cannot grant a role that includes the permission "%", which you do not hold in that scope',
        v_missing
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- Guard 3: never lock everyone out of administration.
  if tg_op = 'DELETE' then
    select count(*) into v_super_admins
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    join public.profiles p on p.id = ur.user_id
    where r.key = 'super_admin'
      and p.is_active
      and ur.id <> old.id;

    if v_super_admins = 0
       and exists (select 1 from public.roles r where r.id = old.role_id and r.key = 'super_admin')
    then
      raise exception 'This is the last active Super Administrator grant and cannot be removed'
        using errcode = 'restrict_violation';
    end if;
  end if;

  return v_row;
end;
$$;

create trigger user_roles_guard_insert
  before insert on public.user_roles
  for each row execute function app.guard_role_grant();

create trigger user_roles_guard_delete
  before delete on public.user_roles
  for each row execute function app.guard_role_grant();

-- ---------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------

create policy settings_select on public.settings
  for select to authenticated
  using (
    is_public
    or (select app.has_permission('settings.view'))
    or (select app.has_permission('settings.manage'))
  );

create policy settings_write on public.settings
  for all to authenticated
  using ((select app.has_permission('settings.manage')))
  with check ((select app.has_permission('settings.manage')));
