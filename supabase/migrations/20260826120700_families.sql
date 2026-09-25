-- ============================================================================
-- 0007 · Families
-- ----------------------------------------------------------------------------
-- Two business rules are enforced in the schema. Both are assumptions about how
-- households work rather than instructions from the church, and both are one
-- dropped index away from being relaxed:
--
--   * a family has at most one head
--   * a member belongs to at most one household
--
-- `families.head_member_id` was considered and rejected: it would duplicate
-- what `family_members.relationship = 'head'` already says, and the two would
-- eventually disagree.
--
-- Note the `branch_id` column on the join table. It exists so the composite
-- foreign keys can guarantee a family and its members belong to the SAME
-- branch — cross-branch corruption becomes impossible rather than merely
-- unlikely. The same pattern is used by every join table from here on.
-- ============================================================================

create table public.families (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches (id) on delete restrict,
  family_name text not null,
  household_phone text,
  household_email text,
  address_line text,
  city text,
  region text,
  country text,
  notes text,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint families_id_branch_key unique (id, branch_id),
  constraint families_name_length check (char_length(btrim(family_name)) between 2 and 120),
  constraint families_email_valid check (
    household_email is null or app.is_valid_email(household_email)
  ),
  constraint families_phone_valid check (
    household_phone is null or app.is_valid_phone(household_phone)
  ),
  constraint families_notes_length check (notes is null or char_length(notes) <= 2000)
);

create unique index families_branch_name_key
  on public.families (branch_id, lower(btrim(family_name)));

create index families_branch_id_idx on public.families (branch_id);

create trigger families_touch_updated_at
  before update on public.families
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- family_members
-- ---------------------------------------------------------------------------

create table public.family_members (
  family_id uuid not null,
  member_id uuid not null,
  branch_id uuid not null,
  relationship public.family_relationship not null,
  is_dependent boolean not null default false,
  created_at timestamptz not null default now(),

  primary key (family_id, member_id),

  -- Composite: the family and the member must share this branch_id.
  constraint family_members_family_fkey
    foreign key (family_id, branch_id) references public.families (id, branch_id) on delete cascade,
  constraint family_members_member_fkey
    foreign key (member_id, branch_id) references public.members (id, branch_id) on delete cascade
);

create index family_members_member_id_idx on public.family_members (member_id);
create index family_members_branch_id_idx on public.family_members (branch_id);

create unique index family_members_one_head
  on public.family_members (family_id)
  where relationship = 'head';

create unique index family_members_one_household
  on public.family_members (member_id);

comment on index public.family_members_one_household is
  'A member belongs to one household. Drop this index if the church needs otherwise.';

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- `branch_id` is on both tables, so every policy can use has_permission_in
-- directly — no helper function and no subquery into another table.
-- ---------------------------------------------------------------------------

alter table public.families enable row level security;
alter table public.family_members enable row level security;

create policy families_select on public.families
  for select to authenticated
  using ((select app.has_permission_in('families.view', branch_id)));

-- A member with a login may see their own household.
create policy families_select_own on public.families
  for select to authenticated
  using (
    exists (
      select 1
      from public.family_members fm
      where fm.family_id = families.id
        and fm.member_id = (select app.current_member_id())
    )
  );

create policy families_insert on public.families
  for insert to authenticated
  with check ((select app.has_permission_in('families.create', branch_id)));

create policy families_update on public.families
  for update to authenticated
  using ((select app.has_permission_in('families.update', branch_id)))
  with check ((select app.has_permission_in('families.update', branch_id)));

create policy families_delete on public.families
  for delete to authenticated
  using ((select app.has_permission_in('families.delete', branch_id)));

create policy family_members_select on public.family_members
  for select to authenticated
  using (
    (select app.has_permission_in('families.view', branch_id))
    or member_id = (select app.current_member_id())
  );

create policy family_members_write on public.family_members
  for all to authenticated
  using ((select app.has_permission_in('families.update', branch_id)))
  with check ((select app.has_permission_in('families.update', branch_id)));
