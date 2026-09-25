-- ============================================================================
-- 0010 · Attendance
-- ----------------------------------------------------------------------------
-- Decision D5: attendance is recorded BOTH ways.
--
--   * `attendance_records` — named individuals, which drives follow-up
--     ("who has not attended in six weeks")
--   * headcount columns on the session — the true total, because nobody
--     identifies 200 people at the door
--
-- There is deliberately NO constraint requiring the headcount to be at least
-- the named count. Ushers capture the two independently and reconciling them is
-- a human task; a constraint there would reject honest data entry. Reports show
-- both figures — "212 present, 148 identified" — rather than implying the named
-- count is the attendance.
--
-- Closing a session freezes its records. That is what makes an attendance
-- register a record rather than a working document.
-- ============================================================================

create table public.attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches (id) on delete restrict,
  session_type public.session_type not null,
  title text not null,
  session_date date not null,
  start_time time,
  end_time time,
  -- Exactly one of these is set, according to session_type. See the CHECK below.
  ministry_id uuid,
  event_id uuid,
  status public.session_status not null default 'open',

  -- Headcounts (D5). Independent of the named records.
  count_adults integer not null default 0,
  count_youth integer not null default 0,
  count_children integer not null default 0,
  count_visitors integer not null default 0,
  count_total integer generated always as (
    count_adults + count_youth + count_children + count_visitors
  ) stored,

  notes text,
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null,
  recorded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint attendance_sessions_id_branch_key unique (id, branch_id),
  constraint attendance_sessions_ministry_fkey
    foreign key (ministry_id, branch_id) references public.ministries (id, branch_id) on delete cascade,
  constraint attendance_sessions_event_fkey
    foreign key (event_id, branch_id) references public.events (id, branch_id) on delete cascade,

  constraint attendance_sessions_title_length check (char_length(btrim(title)) between 2 and 160),
  -- The session type and its reference cannot disagree.
  constraint attendance_sessions_type_reference check (
    (session_type = 'service' and ministry_id is null and event_id is null)
    or (session_type = 'ministry' and ministry_id is not null and event_id is null)
    or (session_type = 'event' and event_id is not null and ministry_id is null)
  ),
  constraint attendance_sessions_times check (end_time is null or start_time is null or end_time >= start_time),
  constraint attendance_sessions_date_not_future check (session_date <= current_date + 1),
  constraint attendance_sessions_counts_non_negative check (
    count_adults >= 0 and count_youth >= 0 and count_children >= 0 and count_visitors >= 0
  ),
  constraint attendance_sessions_closed_consistent check (
    (status = 'closed' and closed_at is not null) or (status = 'open' and closed_at is null)
  )
);

-- One service per branch per day per title: stops the double-tap that creates
-- two registers for the same meeting.
create unique index attendance_sessions_service_key
  on public.attendance_sessions (branch_id, session_date, lower(btrim(title)))
  where session_type = 'service';

create index attendance_sessions_branch_date_idx
  on public.attendance_sessions (branch_id, session_date desc);
create index attendance_sessions_open_idx on public.attendance_sessions (branch_id)
  where status = 'open';
create index attendance_sessions_ministry_idx on public.attendance_sessions (ministry_id)
  where ministry_id is not null;
create index attendance_sessions_event_idx on public.attendance_sessions (event_id)
  where event_id is not null;

create trigger attendance_sessions_touch_updated_at
  before update on public.attendance_sessions
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- attendance_records
-- ---------------------------------------------------------------------------

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  branch_id uuid not null,
  member_id uuid,
  guest_name text,
  status public.attendance_status not null default 'present',
  method public.attendance_method not null default 'manual',
  check_in_at timestamptz not null default now(),
  notes text,
  recorded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint attendance_records_session_fkey
    foreign key (session_id, branch_id)
      references public.attendance_sessions (id, branch_id) on delete cascade,
  constraint attendance_records_member_fkey
    foreign key (member_id, branch_id) references public.members (id, branch_id) on delete cascade,

  constraint attendance_records_subject check (
    (member_id is not null and guest_name is null)
    or (member_id is null and guest_name is not null)
  ),
  constraint attendance_records_guest_name_length check (
    guest_name is null or char_length(btrim(guest_name)) between 2 and 120
  )
);

-- A member appears at most once per session.
create unique index attendance_records_member_key
  on public.attendance_records (session_id, member_id)
  where member_id is not null;

create index attendance_records_session_id_idx on public.attendance_records (session_id);
-- The per-member history query, and the "not seen recently" report.
create index attendance_records_member_idx on public.attendance_records (member_id, check_in_at desc)
  where member_id is not null;

-- ---------------------------------------------------------------------------
-- A closed session is frozen
-- ---------------------------------------------------------------------------

create or replace function app.guard_closed_session() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid := coalesce(new.session_id, old.session_id);
  v_status public.session_status;
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;

  select s.status into v_status
  from public.attendance_sessions s
  where s.id = v_session_id;

  if v_status = 'closed' then
    raise exception 'This attendance session is closed; reopen it before changing records'
      using errcode = 'restrict_violation';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger attendance_records_guard_closed
  before insert or update or delete on public.attendance_records
  for each row execute function app.guard_closed_session();

-- Reopening a closed session is a privileged act, not a side effect of an edit.
create or replace function app.guard_session_reopen() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if old.status = 'closed' and new.status = 'open'
     and not app.has_permission_in('attendance.session.close', old.branch_id) then
    raise exception 'Reopening a closed session requires the attendance.session.close permission'
      using errcode = 'insufficient_privilege';
  end if;

  -- Keep closed_at consistent without making the caller remember.
  if old.status = 'open' and new.status = 'closed' then
    new.closed_at := coalesce(new.closed_at, now());
    new.closed_by := coalesce(new.closed_by, auth.uid());
  elsif new.status = 'open' then
    new.closed_at := null;
    new.closed_by := null;
  end if;

  return new;
end;
$$;

create trigger attendance_sessions_guard_reopen
  before update on public.attendance_sessions
  for each row execute function app.guard_session_reopen();

-- ---------------------------------------------------------------------------
-- Leadership scope for attendance
--
-- A ministry leader must be able to run the register for their OWN ministry
-- without holding attendance.record across the whole branch. Without this
-- helper the only way to let a leader mark attendance would be a branch-wide
-- grant, which would also let the choir leader take the Sunday service
-- register — the exact over-reach the leadership model exists to avoid.
-- ---------------------------------------------------------------------------

create or replace function app.leads_session_ministry(p_session_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.attendance_sessions s
    where s.id = p_session_id
      and s.ministry_id is not null
      and s.ministry_id in (select app.my_led_ministry_ids())
  );
$$;

grant execute on function app.leads_session_ministry(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.attendance_sessions enable row level security;
alter table public.attendance_records enable row level security;

create policy attendance_sessions_select on public.attendance_sessions
  for select to authenticated
  using (
    (select app.has_permission_in('attendance.view', branch_id))
    or (ministry_id is not null and (select app.is_ministry_leader(ministry_id)))
  );

create policy attendance_sessions_insert on public.attendance_sessions
  for insert to authenticated
  with check (
    (select app.has_permission_in('attendance.session.create', branch_id))
    or (ministry_id is not null and (select app.is_ministry_leader(ministry_id)))
  );

create policy attendance_sessions_update on public.attendance_sessions
  for update to authenticated
  using (
    (select app.has_permission_in('attendance.session.create', branch_id))
    or (select app.has_permission_in('attendance.session.close', branch_id))
    or (ministry_id is not null and (select app.is_ministry_leader(ministry_id)))
  )
  with check (
    (select app.has_permission_in('attendance.session.create', branch_id))
    or (select app.has_permission_in('attendance.session.close', branch_id))
    or (ministry_id is not null and (select app.is_ministry_leader(ministry_id)))
  );

create policy attendance_sessions_delete on public.attendance_sessions
  for delete to authenticated
  using ((select app.has_permission_in('attendance.delete', branch_id)));

-- A member may see their own attendance history (decision D4). A ministry leader
-- sees the register for their own ministry's sessions.
create policy attendance_records_select on public.attendance_records
  for select to authenticated
  using (
    (select app.has_permission_in('attendance.view', branch_id))
    or member_id = (select app.current_member_id())
    or (member_id is not null and (select app.leads_ministry_of_member(member_id)))
    or (select app.leads_session_ministry(session_id))
  );

create policy attendance_records_insert on public.attendance_records
  for insert to authenticated
  with check (
    (select app.has_permission_in('attendance.record', branch_id))
    or (select app.leads_session_ministry(session_id))
  );

create policy attendance_records_update on public.attendance_records
  for update to authenticated
  using (
    (select app.has_permission_in('attendance.update', branch_id))
    or (select app.leads_session_ministry(session_id))
  )
  with check (
    (select app.has_permission_in('attendance.update', branch_id))
    or (select app.leads_session_ministry(session_id))
  );

-- Deleting a register entry stays with staff: a leader corrects by editing.
create policy attendance_records_delete on public.attendance_records
  for delete to authenticated
  using ((select app.has_permission_in('attendance.delete', branch_id)));
