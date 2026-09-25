-- ============================================================================
-- 0003 · Identity, RBAC, and settings — tables
-- ----------------------------------------------------------------------------
-- Row Level Security for these tables is enabled in 0005, after the helper
-- functions the policies depend on exist. Nothing between those two migrations
-- is reachable by a client: `supabase db push` applies them in one run, and no
-- API route touches these tables until Phase 3.
--
-- Multi-branch (decision D2): `branch_id` is present from the start on every
-- branch-scoped table. The UI is single-branch, the schema is not.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- branches
-- ---------------------------------------------------------------------------

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  address_line text,
  city text,
  region text,
  country text,
  phone text,
  email text,
  -- IANA name, e.g. 'Africa/Accra'. Attendance dates and event times are shown
  -- in branch-local time; everything is stored as timestamptz.
  timezone text not null default 'UTC',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint branches_code_format check (code ~ '^[A-Z][A-Z0-9-]{1,9}$'),
  constraint branches_name_length check (char_length(btrim(name)) between 2 and 120),
  constraint branches_email_valid check (email is null or app.is_valid_email(email)),
  constraint branches_phone_valid check (phone is null or app.is_valid_phone(phone))
);

create unique index branches_code_key on public.branches (code);
create unique index branches_name_key on public.branches (lower(btrim(name)));

create trigger branches_touch_updated_at
  before update on public.branches
  for each row execute function app.touch_updated_at();

comment on table public.branches is
  'Church branches. One row is seeded; the schema supports many (decision D2).';

-- ---------------------------------------------------------------------------
-- profiles — application data for an authenticated user
--
-- One row per auth.users row, same id. Supabase owns auth.users; everything
-- the application needs to know about a user lives here, where RLS applies.
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  phone text,
  avatar_path text,
  default_branch_id uuid references public.branches (id) on delete set null,
  -- Deactivation is reversible and preserves history; deleting the auth user is
  -- not. `is_active` false blocks every request in the session middleware.
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint profiles_full_name_length check (char_length(btrim(full_name)) between 2 and 120),
  constraint profiles_phone_valid check (phone is null or app.is_valid_phone(phone))
);

create index profiles_default_branch_id_idx on public.profiles (default_branch_id);
create index profiles_is_active_idx on public.profiles (is_active) where is_active;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------------

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  name text not null,
  description text,
  -- System roles are seeded and referenced by the bootstrap logic; they may be
  -- renamed but not deleted. Enforced by a trigger below.
  is_system boolean not null default false,
  sort_order smallint not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint roles_key_format check (key ~ '^[a-z][a-z0-9_]{2,39}$'),
  constraint roles_name_length check (char_length(btrim(name)) between 2 and 60)
);

create unique index roles_key_key on public.roles (key);

create trigger roles_touch_updated_at
  before update on public.roles
  for each row execute function app.touch_updated_at();

create or replace function app.guard_system_role() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.is_system then
    raise exception 'Role "%" is a system role and cannot be deleted', old.key
      using errcode = 'restrict_violation';
  end if;
  return old;
end;
$$;

create trigger roles_protect_system
  before delete on public.roles
  for each row execute function app.guard_system_role();

-- ---------------------------------------------------------------------------
-- permissions
--
-- Seeded reference data. Never edited through the API — there are no write
-- policies at all, so only a migration (running as the table owner) can change
-- the catalogue. New permissions arrive with the feature that needs them.
-- ---------------------------------------------------------------------------

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  resource text not null,
  action text not null,
  description text not null,
  -- First segment of the key, for grouping in the role editor UI.
  group_key text generated always as (split_part(key, '.', 1)) stored,
  created_at timestamptz not null default now(),

  constraint permissions_key_format check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  -- resource is everything before the last dot, action everything after, so the
  -- three columns can never disagree.
  constraint permissions_key_matches_parts check (key = resource || '.' || action)
);

create unique index permissions_key_key on public.permissions (key);
create unique index permissions_resource_action_key on public.permissions (resource, action);
create index permissions_group_key_idx on public.permissions (group_key);

-- ---------------------------------------------------------------------------
-- role_permissions
-- ---------------------------------------------------------------------------

create table public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  created_at timestamptz not null default now(),

  primary key (role_id, permission_id)
);

-- The PK covers role_id lookups; this covers the reverse ("which roles grant
-- members.delete?"), which the role editor and the escalation guard both need.
create index role_permissions_permission_id_idx on public.role_permissions (permission_id);

-- ---------------------------------------------------------------------------
-- user_roles — the grant table
--
-- branch_id NULL means "in every branch". That is how a Super Administrator or
-- Senior Pastor is represented, rather than by a special case in code.
-- ---------------------------------------------------------------------------

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  role_id uuid not null references public.roles (id) on delete restrict,
  branch_id uuid references public.branches (id) on delete cascade,
  granted_by uuid references public.profiles (id) on delete set null,
  granted_at timestamptz not null default now()
);

-- Two partial indexes rather than one over coalesce(branch_id, sentinel): both
-- are usable by the planner and neither needs a magic UUID.
create unique index user_roles_global_key
  on public.user_roles (user_id, role_id)
  where branch_id is null;

create unique index user_roles_branch_key
  on public.user_roles (user_id, role_id, branch_id)
  where branch_id is not null;

create index user_roles_user_id_idx on public.user_roles (user_id);
create index user_roles_role_id_idx on public.user_roles (role_id);
create index user_roles_branch_id_idx on public.user_roles (branch_id) where branch_id is not null;

comment on column public.user_roles.branch_id is
  'NULL grants the role in every branch. Otherwise the grant is scoped to one branch.';

-- ---------------------------------------------------------------------------
-- settings
--
-- `is_public` means "any signed-in user may read this" — the church name and
-- currency, for example. Everything else needs settings.view. Without that
-- split, exposing one harmless setting to the UI would expose all of them.
-- ---------------------------------------------------------------------------

create table public.settings (
  id uuid primary key default gen_random_uuid(),
  scope public.settings_scope not null,
  branch_id uuid references public.branches (id) on delete cascade,
  key text not null,
  value jsonb,
  description text,
  is_public boolean not null default false,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint settings_key_format check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  constraint settings_scope_branch check (
    (scope = 'global' and branch_id is null) or (scope = 'branch' and branch_id is not null)
  )
);

create unique index settings_global_key on public.settings (key) where scope = 'global';
create unique index settings_branch_key on public.settings (branch_id, key) where scope = 'branch';

create trigger settings_touch_updated_at
  before update on public.settings
  for each row execute function app.touch_updated_at();
