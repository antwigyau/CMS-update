-- ============================================================================
-- 0009 · Events
-- ----------------------------------------------------------------------------
-- Events come before attendance because an attendance session may reference one.
--
-- Registration and attendance are kept separate on purpose: registering is an
-- intention, attending is a fact. Attendance for an event is recorded through
-- `attendance_sessions` like every other kind, so there is one attendance
-- mechanism in the system rather than two that must be kept in step.
-- ============================================================================

-- Church-wide, not branch-scoped: categories are a shared vocabulary and
-- reports group by them across branches.
create table public.event_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  -- Hex colour for the calendar. Validated so it can be used in CSS safely.
  colour text,
  is_active boolean not null default true,
  sort_order smallint not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint event_categories_name_length check (char_length(btrim(name)) between 2 and 60),
  constraint event_categories_colour_format check (colour is null or colour ~ '^#[0-9a-fA-F]{6}$')
);

create unique index event_categories_name_key on public.event_categories (lower(btrim(name)));

create trigger event_categories_touch_updated_at
  before update on public.event_categories
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------

create table public.events (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches (id) on delete restrict,
  category_id uuid references public.event_categories (id) on delete set null,
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  venue text,
  -- Optional links, each constrained to the same branch as the event.
  ministry_id uuid,
  organizer_member_id uuid,
  status public.event_status not null default 'draft',
  -- Visible to the Guest role and on any future public page.
  is_public boolean not null default false,
  capacity integer,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint events_id_branch_key unique (id, branch_id),
  constraint events_ministry_fkey
    foreign key (ministry_id, branch_id) references public.ministries (id, branch_id) on delete set null,
  constraint events_organizer_fkey
    foreign key (organizer_member_id, branch_id) references public.members (id, branch_id) on delete set null,

  constraint events_title_length check (char_length(btrim(title)) between 2 and 160),
  constraint events_ends_after_starts check (ends_at > starts_at),
  constraint events_capacity_positive check (capacity is null or capacity > 0),
  constraint events_description_length check (description is null or char_length(description) <= 8000)
);

-- The calendar query: one branch, a date window.
create index events_branch_starts_at_idx on public.events (branch_id, starts_at desc);
-- The "upcoming events" dashboard widget.
create index events_upcoming_idx on public.events (starts_at)
  where status in ('published', 'ongoing');
create index events_category_id_idx on public.events (category_id);
create index events_ministry_id_idx on public.events (ministry_id) where ministry_id is not null;

create trigger events_touch_updated_at
  before update on public.events
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- event_registrations
--
-- Either a member or a named guest — an event can take sign-ups from people who
-- are not on the roll, which is often the point of an outreach event.
-- ---------------------------------------------------------------------------

create table public.event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  branch_id uuid not null,
  member_id uuid,
  guest_name text,
  guest_phone text,
  guest_email text,
  status public.registration_status not null default 'registered',
  notes text,
  registered_at timestamptz not null default now(),
  registered_by uuid references auth.users (id) on delete set null,

  constraint event_registrations_event_fkey
    foreign key (event_id, branch_id) references public.events (id, branch_id) on delete cascade,
  constraint event_registrations_member_fkey
    foreign key (member_id, branch_id) references public.members (id, branch_id) on delete cascade,

  constraint event_registrations_subject check (
    (member_id is not null and guest_name is null)
    or (member_id is null and guest_name is not null)
  ),
  constraint event_registrations_guest_name_length check (
    guest_name is null or char_length(btrim(guest_name)) between 2 and 120
  ),
  constraint event_registrations_guest_phone_valid check (
    guest_phone is null or app.is_valid_phone(guest_phone)
  ),
  constraint event_registrations_guest_email_valid check (
    guest_email is null or app.is_valid_email(guest_email)
  )
);

create unique index event_registrations_member_key
  on public.event_registrations (event_id, member_id)
  where member_id is not null;

create index event_registrations_event_id_idx on public.event_registrations (event_id);
create index event_registrations_member_id_idx on public.event_registrations (member_id)
  where member_id is not null;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.event_categories enable row level security;
alter table public.events enable row level security;
alter table public.event_registrations enable row level security;

create policy event_categories_select on public.event_categories
  for select to authenticated
  using (true);

create policy event_categories_write on public.event_categories
  for all to authenticated
  using ((select app.has_permission('settings.manage')))
  with check ((select app.has_permission('settings.manage')));

-- Draft events are internal. Published ones are visible to anyone who can see
-- events in that branch; public ones to any signed-in user, which is what the
-- Guest role gets.
create policy events_select on public.events
  for select to authenticated
  using (
    (is_public and status in ('published', 'ongoing', 'completed'))
    or (
      (select app.has_permission_in('events.view', branch_id))
      and (status <> 'draft' or (select app.has_permission_in('events.create', branch_id)))
    )
    or (ministry_id is not null and (select app.is_ministry_leader(ministry_id)))
  );

create policy events_insert on public.events
  for insert to authenticated
  with check (
    (select app.has_permission_in('events.create', branch_id))
    or (ministry_id is not null and (select app.is_ministry_leader(ministry_id)))
  );

create policy events_update on public.events
  for update to authenticated
  using (
    (select app.has_permission_in('events.update', branch_id))
    or (ministry_id is not null and (select app.is_ministry_leader(ministry_id)))
  )
  with check (
    (select app.has_permission_in('events.update', branch_id))
    or (ministry_id is not null and (select app.is_ministry_leader(ministry_id)))
  );

create policy events_delete on public.events
  for delete to authenticated
  using ((select app.has_permission_in('events.delete', branch_id)));

create policy event_registrations_select on public.event_registrations
  for select to authenticated
  using (
    (select app.has_permission_in('events.view', branch_id))
    or member_id = (select app.current_member_id())
  );

create policy event_registrations_write on public.event_registrations
  for all to authenticated
  using ((select app.has_permission_in('events.attendance.manage', branch_id)))
  with check ((select app.has_permission_in('events.attendance.manage', branch_id)));
