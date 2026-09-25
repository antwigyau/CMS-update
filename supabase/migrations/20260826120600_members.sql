-- ============================================================================
-- 0006 · Members
-- ----------------------------------------------------------------------------
-- Field set per §13 of the specification and decision D7 (spiritual gifts as a
-- controlled list, free-text notes retained). Nothing sensitive was added
-- beyond that list: no national ID, no income data, no health information.
--
-- Two design points worth reading before changing anything here:
--
-- 1. Soft delete. `deleted_at` rather than DELETE, so an accidental removal is
--    recoverable and attendance history keeps its subject. Every unique index
--    that a user could collide with is partial on `deleted_at is null`, so
--    deleting a member frees their email for reuse.
--
-- 2. The directory. `members.view_directory` is a separate permission from
--    `members.view`, exposed through a SECURITY DEFINER function that returns
--    five columns and nothing else. An usher marking attendance needs a name
--    and a photo; they should not thereby get home addresses and dates of birth.
-- ============================================================================

create sequence public.member_no_seq as bigint start 1;

create table public.members (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches (id) on delete restrict,
  -- Assigned by trigger as <branch code>-000123. Immutable once set.
  member_no text not null,
  -- Set only for the minority of members who have a login (decision D4).
  user_id uuid unique references auth.users (id) on delete set null,

  -- personal
  first_name text not null,
  middle_name text,
  last_name text not null,
  full_name text generated always as (
    btrim(first_name || ' ' || coalesce(middle_name || ' ', '') || last_name)
  ) stored,
  gender public.gender,
  date_of_birth date,
  marital_status public.marital_status,
  occupation text,

  -- contact
  phone text,
  alt_phone text,
  email text,
  address_line text,
  city text,
  region text,
  country text,
  nationality text,

  -- church
  membership_status public.membership_status not null default 'visitor',
  date_joined date,
  is_baptized boolean not null default false,
  baptism_date date,
  photo_path text,
  notes text,

  -- lifecycle
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  -- Target for the composite foreign keys that stop join tables mixing branches.
  constraint members_id_branch_key unique (id, branch_id),

  constraint members_first_name_length check (char_length(btrim(first_name)) between 1 and 80),
  constraint members_last_name_length check (char_length(btrim(last_name)) between 1 and 80),
  constraint members_email_valid check (email is null or app.is_valid_email(email)),
  constraint members_phone_valid check (phone is null or app.is_valid_phone(phone)),
  constraint members_alt_phone_valid check (alt_phone is null or app.is_valid_phone(alt_phone)),
  constraint members_notes_length check (notes is null or char_length(notes) <= 4000),

  -- A future date of birth is a typo, not a member.
  constraint members_dob_not_future check (date_of_birth is null or date_of_birth <= current_date),
  constraint members_joined_after_birth check (
    date_joined is null or date_of_birth is null or date_joined >= date_of_birth
  ),
  -- A baptism date only means something if the member is recorded as baptised,
  -- and it cannot precede their birth.
  constraint members_baptism_consistent check (
    (baptism_date is null) or (is_baptized and (date_of_birth is null or baptism_date >= date_of_birth))
  ),
  constraint members_member_no_format check (member_no ~ '^[A-Z][A-Z0-9-]{1,9}-[0-9]{6}$')
);

-- ---- indexes --------------------------------------------------------------

create unique index members_member_no_key on public.members (member_no);

-- Partial, so a soft-deleted member does not block the reuse of their email.
create unique index members_branch_email_key
  on public.members (branch_id, lower(email))
  where email is not null and deleted_at is null;

create index members_branch_status_idx on public.members (branch_id, membership_status)
  where deleted_at is null;
create index members_branch_live_idx on public.members (branch_id) where deleted_at is null;
create index members_date_joined_idx on public.members (date_joined) where deleted_at is null;
create index members_name_idx on public.members (last_name, first_name) where deleted_at is null;
create index members_user_id_idx on public.members (user_id) where user_id is not null;

-- Full-text search over the fields a user would actually type. 'simple' rather
-- than a language configuration: stemming English rules over Ghanaian, Akan, or
-- Yoruba names produces worse matches, not better ones.
alter table public.members
  add column search_vector tsvector generated always as (
    to_tsvector(
      'simple',
      coalesce(first_name, '') || ' ' ||
      coalesce(middle_name, '') || ' ' ||
      coalesce(last_name, '') || ' ' ||
      coalesce(member_no, '') || ' ' ||
      coalesce(email, '') || ' ' ||
      coalesce(phone, '')
    )
  ) stored;

create index members_search_idx on public.members using gin (search_vector);

create trigger members_touch_updated_at
  before update on public.members
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Member number assignment
-- ---------------------------------------------------------------------------

create or replace function app.assign_member_no() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  if new.member_no is not null then
    return new;
  end if;

  select b.code into v_code from public.branches b where b.id = new.branch_id;
  if v_code is null then
    raise exception 'Cannot assign a member number: branch % does not exist', new.branch_id
      using errcode = 'foreign_key_violation';
  end if;

  new.member_no := v_code || '-' || lpad(nextval('public.member_no_seq')::text, 6, '0');
  return new;
end;
$$;

create trigger members_assign_member_no
  before insert on public.members
  for each row execute function app.assign_member_no();

-- ---------------------------------------------------------------------------
-- Field-level guards
--
-- RLS decides which ROWS a user may update. These decide which COLUMNS, which
-- a USING clause cannot express. Without this, a member with a login could edit
-- their own record — as the policy intends — and set their own membership status
-- to active, move themselves to another branch, or claim a different member row.
-- ---------------------------------------------------------------------------

create or replace function app.guard_member_update() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new; -- migration, seed, or service-role provisioning
  end if;

  if new.member_no is distinct from old.member_no then
    raise exception 'A member number cannot be changed once assigned'
      using errcode = 'restrict_violation';
  end if;

  if new.branch_id is distinct from old.branch_id
     and not app.has_permission('branches.manage') then
    raise exception 'Moving a member to another branch requires the branches.manage permission'
      using errcode = 'insufficient_privilege';
  end if;

  if new.user_id is distinct from old.user_id
     and not app.has_permission('users.update') then
    raise exception 'Linking a member to a login requires the users.update permission'
      using errcode = 'insufficient_privilege';
  end if;

  if new.membership_status is distinct from old.membership_status
     and not app.has_permission_in('members.update', old.branch_id) then
    raise exception 'Changing membership status requires the members.update permission'
      using errcode = 'insufficient_privilege';
  end if;

  -- Soft delete and restore are both privileged, and are the only way a member
  -- record leaves or re-enters the roll.
  if (new.deleted_at is null) is distinct from (old.deleted_at is null)
     and not app.has_permission_in('members.delete', old.branch_id) then
    raise exception 'Removing or restoring a member requires the members.delete permission'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger members_guard_update
  before update on public.members
  for each row execute function app.guard_member_update();

-- ---------------------------------------------------------------------------
-- Emergency contacts
-- ---------------------------------------------------------------------------

create table public.member_emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members (id) on delete cascade,
  name text not null,
  relationship text not null,
  phone text not null,
  alt_phone text,
  address_line text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint mec_name_length check (char_length(btrim(name)) between 2 and 120),
  constraint mec_relationship_length check (char_length(btrim(relationship)) between 2 and 60),
  constraint mec_phone_valid check (app.is_valid_phone(phone)),
  constraint mec_alt_phone_valid check (alt_phone is null or app.is_valid_phone(alt_phone))
);

create index mec_member_id_idx on public.member_emergency_contacts (member_id);
create unique index mec_one_primary_per_member
  on public.member_emergency_contacts (member_id)
  where is_primary;

create trigger mec_touch_updated_at
  before update on public.member_emergency_contacts
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Spiritual gifts (decision D7: a controlled list, not free text)
--
-- A lookup table rather than an enum, because which gifts a church recognises
-- is church policy and administrators will edit it. An enum would need a
-- migration for every change.
-- ---------------------------------------------------------------------------

create table public.spiritual_gifts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  is_active boolean not null default true,
  sort_order smallint not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint spiritual_gifts_name_length check (char_length(btrim(name)) between 2 and 60)
);

create unique index spiritual_gifts_name_key on public.spiritual_gifts (lower(btrim(name)));

create trigger spiritual_gifts_touch_updated_at
  before update on public.spiritual_gifts
  for each row execute function app.touch_updated_at();

create table public.member_spiritual_gifts (
  member_id uuid not null references public.members (id) on delete cascade,
  gift_id uuid not null references public.spiritual_gifts (id) on delete restrict,
  noted_at date not null default current_date,
  created_at timestamptz not null default now(),

  primary key (member_id, gift_id)
);

create index msg_gift_id_idx on public.member_spiritual_gifts (gift_id);

-- ---------------------------------------------------------------------------
-- Member-scoped authorization helpers
--
-- Written once here and reused by every policy on a member's child records, so
-- "who may see this member" is defined in exactly one place. Migration 0008
-- replaces both to add ministry-leader scope, once ministries exist.
-- ---------------------------------------------------------------------------

create or replace function app.current_member_id() returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from public.members m
  where m.user_id = auth.uid()
    and m.deleted_at is null
  limit 1;
$$;

create or replace function app.can_view_member(p_member_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.members m
    where m.id = p_member_id
      and m.deleted_at is null
      and (
        app.has_permission_in('members.view', m.branch_id)
        or m.user_id = auth.uid()
      )
  );
$$;

create or replace function app.can_edit_member(p_member_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.members m
    where m.id = p_member_id
      and m.deleted_at is null
      and app.has_permission_in('members.update', m.branch_id)
  );
$$;

grant execute on function app.current_member_id() to authenticated, service_role;
grant execute on function app.can_view_member(uuid) to authenticated, service_role;
grant execute on function app.can_edit_member(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The restricted directory
--
-- A function rather than a view, for two reasons: it returns only the columns
-- an usher needs, and it enforces its own permission. A view would either apply
-- the caller's RLS (and so need members.view, defeating the purpose) or bypass
-- it as a definer view, which Supabase's own security advisor flags.
-- ---------------------------------------------------------------------------

create or replace function public.search_member_directory(
  p_branch_id uuid,
  p_query text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid,
  member_no text,
  full_name text,
  photo_path text,
  membership_status public.membership_status
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.member_no, m.full_name, m.photo_path, m.membership_status
  from public.members m
  where app.has_permission_in('members.view_directory', p_branch_id)
    and m.branch_id = p_branch_id
    and m.deleted_at is null
    and (
      p_query is null
      or btrim(p_query) = ''
      or m.search_vector @@ plainto_tsquery('simple', p_query)
    )
  order by m.full_name
  -- Capped server-side: a caller cannot ask for the whole roll in one page.
  limit least(coalesce(p_limit, 25), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.search_member_directory(uuid, text, integer, integer) is
  'Name-and-photo directory for attendance taking. Requires members.view_directory.';

grant execute on function public.search_member_directory(uuid, text, integer, integer)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.members enable row level security;
alter table public.member_emergency_contacts enable row level security;
alter table public.spiritual_gifts enable row level security;
alter table public.member_spiritual_gifts enable row level security;

create policy members_select_live on public.members
  for select to authenticated
  using (
    deleted_at is null
    and (
      (select app.has_permission_in('members.view', branch_id))
      or user_id = (select auth.uid())
    )
  );

-- Soft-deleted rows are visible only to whoever can restore them.
create policy members_select_deleted on public.members
  for select to authenticated
  using (
    deleted_at is not null
    and (select app.has_permission_in('members.delete', branch_id))
  );

create policy members_insert on public.members
  for insert to authenticated
  with check ((select app.has_permission_in('members.create', branch_id)));

create policy members_update on public.members
  for update to authenticated
  using (
    (select app.has_permission_in('members.update', branch_id))
    or user_id = (select auth.uid())
  )
  with check (
    (select app.has_permission_in('members.update', branch_id))
    or user_id = (select auth.uid())
  );

-- No delete policy: removal is a soft delete, guarded by members.delete in the
-- update trigger above.

create policy mec_select on public.member_emergency_contacts
  for select to authenticated
  using ((select app.can_view_member(member_id)));

create policy mec_write on public.member_emergency_contacts
  for all to authenticated
  using ((select app.can_edit_member(member_id)))
  with check ((select app.can_edit_member(member_id)));

-- The gift list is readable by anyone signed in; editing it is a settings task.
create policy spiritual_gifts_select on public.spiritual_gifts
  for select to authenticated
  using (true);

create policy spiritual_gifts_write on public.spiritual_gifts
  for all to authenticated
  using ((select app.has_permission('settings.manage')))
  with check ((select app.has_permission('settings.manage')));

create policy msg_select on public.member_spiritual_gifts
  for select to authenticated
  using ((select app.can_view_member(member_id)));

create policy msg_write on public.member_spiritual_gifts
  for all to authenticated
  using ((select app.can_edit_member(member_id)))
  with check ((select app.can_edit_member(member_id)));
