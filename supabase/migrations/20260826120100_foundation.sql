-- ============================================================================
-- 0001 · Foundation
-- ----------------------------------------------------------------------------
-- The `app` schema, shared trigger functions, and immutable validation helpers
-- used by CHECK constraints throughout the schema.
--
-- `app` is NOT exposed through PostgREST (only `public` and `graphql_public`
-- are), so nothing in it is reachable from an API request. It holds the
-- SECURITY DEFINER helpers that RLS policies call.
--
-- Every SECURITY DEFINER function in this project sets `search_path = ''` and
-- fully qualifies its object names. Without that, a caller who can create
-- objects in a schema earlier in the search path could shadow a table name and
-- have the definer-privileged function read theirs instead.
-- ============================================================================

create schema if not exists app;

revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Shared triggers
-- ---------------------------------------------------------------------------

-- Keeps updated_at honest. Applied to every table that has the column, so an
-- application bug cannot leave a stale timestamp behind.
create or replace function app.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function app.touch_updated_at() is
  'BEFORE UPDATE trigger: sets updated_at to now().';

-- Refuses the operation outright. Used to make audit rows and posted financial
-- records physically immutable, independent of RLS.
create or replace function app.deny_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Rows in %.% cannot be % once written',
    tg_table_schema, tg_table_name, lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

comment on function app.deny_change() is
  'Trigger that always raises. Enforces append-only tables.';

-- ---------------------------------------------------------------------------
-- Validation helpers for CHECK constraints
--
-- These must be IMMUTABLE to be usable in a CHECK. They are deliberately
-- permissive: the database rejects obvious nonsense, while the API layer (zod)
-- and Supabase Auth do the strict validation. A too-clever email regex rejects
-- valid addresses, which is a worse failure than accepting an odd one.
-- ---------------------------------------------------------------------------

create or replace function app.is_valid_email(p_value text) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     and length(p_value) <= 254;
$$;

create or replace function app.is_valid_phone(p_value text) returns boolean
language sql
immutable
set search_path = ''
as $$
  -- Digits, spaces, and the usual separators; 7 to 20 characters.
  select p_value ~ '^\+?[0-9][0-9 ()./-]{6,19}$';
$$;

create or replace function app.is_valid_currency(p_value text) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_value ~ '^[A-Z]{3}$';
$$;

grant execute on function app.is_valid_email(text) to authenticated, service_role;
grant execute on function app.is_valid_phone(text) to authenticated, service_role;
grant execute on function app.is_valid_currency(text) to authenticated, service_role;
