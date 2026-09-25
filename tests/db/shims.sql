-- ============================================================================
-- Supabase shims for the local verification harness
-- ----------------------------------------------------------------------------
-- Applied to an ephemeral PGlite (in-process PostgreSQL) database BEFORE the
-- migrations, so the schema can be executed and exercised without Docker.
--
-- WHAT THIS REPRODUCES FAITHFULLY
--   * the anon / authenticated / service_role roles, and Supabase's default
--     privileges — which is why RLS is load-bearing rather than decorative
--   * auth.uid() reading the `sub` claim from request.jwt.claims
--   * auth.users, and storage.buckets / storage.objects / storage.foldername
--
-- WHAT IT DOES NOT REPRODUCE
--   * GoTrue itself: sign-in, tokens, password hashing, email flows
--   * Supabase Storage's own MIME and size enforcement
--   * PostgREST's request handling
--   * Supabase's security advisors and lint rules
--
-- So: this proves the schema, the constraints, the triggers, and the RLS logic.
-- It does not replace verifying against a real Supabase instance, which is what
-- `supabase start` is for once Docker is available.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Roles, matching Supabase's set
-- ---------------------------------------------------------------------------

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant anon to postgres;
grant authenticated to postgres;
grant service_role to postgres;

-- ---------------------------------------------------------------------------
-- auth schema
-- ---------------------------------------------------------------------------

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  created_at timestamptz not null default now()
);

-- The claim carrier. Tests set request.jwt.claims and then SET ROLE, exactly as
-- PostgREST does per request.
create or replace function auth.jwt() returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

create or replace function auth.uid() returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

create or replace function auth.role() returns text
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'role', '');
$$;

grant execute on function auth.jwt() to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- storage schema
-- ---------------------------------------------------------------------------

create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

grant select, insert, update, delete on storage.objects to authenticated, service_role;
grant select on storage.buckets to authenticated, service_role;

-- Matches Supabase's implementation: the path segments WITHOUT the filename, so
-- foldername('branch/member/file.webp') = {branch, member}.
create or replace function storage.foldername(name text) returns text[]
language plpgsql
immutable
as $$
declare
  _parts text[];
begin
  _parts := string_to_array(name, '/');
  if array_length(_parts, 1) is null or array_length(_parts, 1) < 2 then
    return array[]::text[];
  end if;
  return _parts[1:array_length(_parts, 1) - 1];
end;
$$;

create or replace function storage.filename(name text) returns text
language sql
immutable
as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)];
$$;

grant execute on function storage.foldername(text) to anon, authenticated, service_role;
grant execute on function storage.filename(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Default privileges
--
-- This is the important part. Supabase grants broad table privileges to anon and
-- authenticated, which is precisely why every table needs RLS. Reproducing it
-- here means an RLS test that passes is testing something real: without these
-- grants, `set role authenticated` would be denied by table privileges and every
-- test would "pass" for the wrong reason.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
