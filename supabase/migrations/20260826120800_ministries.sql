-- ============================================================================
-- 0008 · Ministries
-- ----------------------------------------------------------------------------
-- This migration also completes the members authorization model. A ministry
-- leader must be able to see the members of the ministry they lead, and that
-- scope cannot be expressed as a permission grant — it is computed from
-- `ministry_members`, which only exists as of this file. So `can_view_member`
-- is replaced here rather than defined twice.
--
-- Leadership is deliberately not a role in `user_roles`. Making it data in
-- `ministry_members` means appointing a leader is an ordinary edit, and the
-- scope follows automatically when someone hands the ministry over.
-- ============================================================================

create table public.ministries (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches (id) on delete restrict,
  name text not null,
  code text,
  description text,
  status public.ministry_status not null default 'active',
  -- ISO-8601 day of week: 1 = Monday ... 7 = Sunday.
  meeting_day smallint,
  meeting_time time,
  meeting_location text,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ministries_id_branch_key unique (id, branch_id),
  constraint ministries_name_length check (char_length(btrim(name)) between 2 and 120),
  constraint ministries_code_format check (code is null or code ~ '^[A-Z][A-Z0-9_-]{1,15}$'),
  constraint ministries_meeting_day_range check (meeting_day is null or meeting_day between 1 and 7)
);

create unique index ministries_branch_name_key on public.ministries (branch_id, lower(btrim(name)));
create unique index ministries_branch_code_key
  on public.ministries (branch_id, code)
  where code is not null;
create index ministries_branch_status_idx on public.ministries (branch_id, status);

create trigger ministries_touch_updated_at
  before update on public.ministries
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- ministry_members
--
-- `left_on` keeps history: a member who leaves a ministry is not deleted from
-- it, so past attendance and past leadership remain explicable. Every "current
-- membership" index is therefore partial on `left_on is null`.
-- ---------------------------------------------------------------------------

create table public.ministry_members (
  id uuid primary key default gen_random_uuid(),
  ministry_id uuid not null,
  member_id uuid not null,
  branch_id uuid not null,
  role_in_ministry public.ministry_role not null default 'member',
  joined_on date not null default current_date,
  left_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ministry_members_ministry_fkey
    foreign key (ministry_id, branch_id) references public.ministries (id, branch_id) on delete cascade,
  constraint ministry_members_member_fkey
    foreign key (member_id, branch_id) references public.members (id, branch_id) on delete cascade,
  constraint ministry_members_dates check (left_on is null or left_on >= joined_on)
);

create unique index ministry_members_active_key
  on public.ministry_members (ministry_id, member_id)
  where left_on is null;

create unique index ministry_members_one_active_leader
  on public.ministry_members (ministry_id)
  where role_in_ministry = 'leader' and left_on is null;

create index ministry_members_member_id_idx on public.ministry_members (member_id);
create index ministry_members_branch_id_idx on public.ministry_members (branch_id);
create index ministry_members_active_idx
  on public.ministry_members (ministry_id)
  where left_on is null;

comment on index public.ministry_members_one_active_leader is
  'One leader per ministry at a time. Assistants use role_in_ministry = assistant_leader.';

create trigger ministry_members_touch_updated_at
  before update on public.ministry_members
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Leadership scope helpers
-- ---------------------------------------------------------------------------

-- Ministries the caller currently leads or assists in leading.
create or replace function app.my_led_ministry_ids() returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select mm.ministry_id
  from public.ministry_members mm
  join public.members m on m.id = mm.member_id
  where m.user_id = auth.uid()
    and m.deleted_at is null
    and mm.left_on is null
    and mm.role_in_ministry in ('leader', 'assistant_leader');
$$;

create or replace function app.is_ministry_leader(p_ministry_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.ministry_members mm
    join public.members m on m.id = mm.member_id
    where mm.ministry_id = p_ministry_id
      and m.user_id = auth.uid()
      and m.deleted_at is null
      and mm.left_on is null
      and mm.role_in_ministry in ('leader', 'assistant_leader')
  );
$$;

-- Does the caller lead a ministry that this member currently belongs to?
--
-- SECURITY DEFINER on purpose: a policy on `members` that queried
-- `ministry_members` directly would have that table's own RLS applied inside the
-- subquery, so a leader could be hidden from their own membership rows.
create or replace function app.leads_ministry_of_member(p_member_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.ministry_members mm
    where mm.member_id = p_member_id
      and mm.left_on is null
      and mm.ministry_id in (select app.my_led_ministry_ids())
  );
$$;

grant execute on function app.my_led_ministry_ids() to authenticated, service_role;
grant execute on function app.is_ministry_leader(uuid) to authenticated, service_role;
grant execute on function app.leads_ministry_of_member(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Completing the member authorization model
--
-- Replaces the definition from 0006 to add ministry-leader scope. Child records
-- (emergency contacts, spiritual gifts) inherit the new scope automatically,
-- because their policies call this function rather than repeating the rule.
-- ---------------------------------------------------------------------------

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
        or app.leads_ministry_of_member(p_member_id)
      )
  );
$$;

create policy members_select_led_ministry on public.members
  for select to authenticated
  using (deleted_at is null and (select app.leads_ministry_of_member(id)));

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.ministries enable row level security;
alter table public.ministry_members enable row level security;

create policy ministries_select on public.ministries
  for select to authenticated
  using (
    (select app.has_permission_in('ministries.view', branch_id))
    or (select app.is_ministry_leader(id))
  );

create policy ministries_insert on public.ministries
  for insert to authenticated
  with check ((select app.has_permission_in('ministries.create', branch_id)));

-- A leader may maintain the details of their own ministry (meeting time,
-- description) without holding ministries.update across the branch.
create policy ministries_update on public.ministries
  for update to authenticated
  using (
    (select app.has_permission_in('ministries.update', branch_id))
    or (select app.is_ministry_leader(id))
  )
  with check (
    (select app.has_permission_in('ministries.update', branch_id))
    or (select app.is_ministry_leader(id))
  );

create policy ministries_delete on public.ministries
  for delete to authenticated
  using ((select app.has_permission_in('ministries.delete', branch_id)));

create policy ministry_members_select on public.ministry_members
  for select to authenticated
  using (
    (select app.has_permission_in('ministries.view', branch_id))
    or (select app.is_ministry_leader(ministry_id))
    or member_id = (select app.current_member_id())
  );

create policy ministry_members_write on public.ministry_members
  for all to authenticated
  using (
    (select app.has_permission_in('ministries.members.manage', branch_id))
    or (select app.is_ministry_leader(ministry_id))
  )
  with check (
    (select app.has_permission_in('ministries.members.manage', branch_id))
    or (select app.is_ministry_leader(ministry_id))
  );
