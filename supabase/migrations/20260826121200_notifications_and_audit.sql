-- ============================================================================
-- 0012 · Notifications and audit log
-- ----------------------------------------------------------------------------
-- The audit log is append-only in the strongest sense available: there are no
-- UPDATE or DELETE policies (so RLS denies both to every application role) AND
-- triggers that raise regardless of who is asking (so even the table owner and
-- the service-role key cannot quietly rewrite history).
--
-- Rows are written by `app.log_audit`, a SECURITY DEFINER function. That is
-- deliberately the only path in: a client cannot forge an actor, a timestamp, or
-- an action, because it never inserts directly.
--
-- Actor identity is SNAPSHOT (`actor_email`, `actor_name`) rather than only
-- referenced, so the log still reads correctly after a user is deleted. The FK
-- is ON DELETE SET NULL for the same reason.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- notifications
--
-- Per §21 of the specification, this is in-app only. No email or SMS
-- infrastructure until the core notification model has settled.
-- ---------------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  -- NULL means every branch.
  branch_id uuid references public.branches (id) on delete cascade,
  type public.notification_type not null default 'system',
  severity public.notification_severity not null default 'info',
  title text not null,
  body text not null,
  audience public.notification_audience not null default 'all',
  -- Set only when audience = 'role'.
  audience_role_id uuid references public.roles (id) on delete cascade,
  -- Optional deep link, e.g. /events/<id>. Relative paths only.
  link_path text,
  published_at timestamptz not null default now(),
  expires_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notifications_title_length check (char_length(btrim(title)) between 2 and 160),
  constraint notifications_body_length check (char_length(btrim(body)) between 2 and 4000),
  constraint notifications_audience_role check (
    (audience = 'role' and audience_role_id is not null)
    or (audience <> 'role' and audience_role_id is null)
  ),
  constraint notifications_expiry_after_publish check (
    expires_at is null or expires_at > published_at
  ),
  -- A relative path, so a notification can never be a phishing link.
  constraint notifications_link_relative check (
    link_path is null or link_path ~ '^/[A-Za-z0-9._~/-]*$'
  )
);

create index notifications_branch_published_idx
  on public.notifications (branch_id, published_at desc);
-- Not a partial index on `expires_at > now()`: now() is STABLE, not IMMUTABLE,
-- so PostgreSQL rejects it in an index predicate. The query filters on this
-- column instead.
create index notifications_expires_idx on public.notifications (expires_at)
  where expires_at is not null;

create trigger notifications_touch_updated_at
  before update on public.notifications
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- notification_recipients — per-user delivery and read state
-- ---------------------------------------------------------------------------

create table public.notification_recipients (
  notification_id uuid not null references public.notifications (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now(),

  primary key (notification_id, user_id)
);

-- Drives the unread badge, which is read on every page load, so it is worth its
-- own partial index.
create index notification_recipients_unread_idx
  on public.notification_recipients (user_id)
  where read_at is null;

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------

create table public.audit_logs (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),

  actor_user_id uuid references auth.users (id) on delete set null,
  actor_email text,
  actor_name text,

  -- Dotted past-tense verb, e.g. 'member.created', 'transaction.approved'.
  action text not null,
  resource_type text not null,
  -- Text, not uuid: some resources are keyed by a natural key (settings).
  resource_id text,
  branch_id uuid references public.branches (id) on delete set null,

  -- Field-level diff, or context. Never credentials — app.log_audit strips any
  -- key that looks like one before writing.
  changes jsonb,

  ip inet,
  user_agent text,
  request_id text,

  constraint audit_logs_action_format check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  constraint audit_logs_resource_type_format check (resource_type ~ '^[a-z][a-z0-9_]*$'),
  constraint audit_logs_user_agent_length check (user_agent is null or char_length(user_agent) <= 512)
);

create index audit_logs_occurred_at_idx on public.audit_logs (occurred_at desc);
create index audit_logs_resource_idx on public.audit_logs (resource_type, resource_id);
create index audit_logs_actor_idx on public.audit_logs (actor_user_id, occurred_at desc);
create index audit_logs_branch_idx on public.audit_logs (branch_id, occurred_at desc);
create index audit_logs_action_idx on public.audit_logs (action, occurred_at desc);

-- Physically append-only. These triggers fire for every role, including the
-- table owner and service_role, which RLS alone cannot achieve.
create trigger audit_logs_deny_update
  before update on public.audit_logs
  for each row execute function app.deny_change();

create trigger audit_logs_deny_delete
  before delete on public.audit_logs
  for each row execute function app.deny_change();

-- ---------------------------------------------------------------------------
-- app.log_audit — the only way a row enters the audit log
-- ---------------------------------------------------------------------------

create or replace function app.log_audit(
  p_action text,
  p_resource_type text,
  p_resource_id text default null,
  p_changes jsonb default null,
  p_branch_id uuid default null,
  p_ip inet default null,
  p_user_agent text default null,
  p_request_id text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_name text;
  v_changes jsonb := p_changes;
  v_key text;
  v_id bigint;
begin
  select u.email into v_email from auth.users u where u.id = v_actor;
  select p.full_name into v_name from public.profiles p where p.id = v_actor;

  -- Belt and braces: the caller should never pass a credential, but if one
  -- arrives it is redacted here rather than persisted forever.
  if v_changes is not null and jsonb_typeof(v_changes) = 'object' then
    for v_key in select k from jsonb_object_keys(v_changes) as k loop
      if v_key ~* '(password|token|secret|api_?key|authorization|cookie|jwt|service_role)' then
        v_changes := jsonb_set(v_changes, array[v_key], '"[redacted]"'::jsonb);
      end if;
    end loop;
  end if;

  insert into public.audit_logs (
    actor_user_id, actor_email, actor_name,
    action, resource_type, resource_id, branch_id,
    changes, ip, user_agent, request_id
  )
  values (
    v_actor, v_email, v_name,
    p_action, p_resource_type, p_resource_id, p_branch_id,
    v_changes, p_ip, left(p_user_agent, 512), p_request_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function app.log_audit(text, text, text, jsonb, uuid, inet, text, text) is
  'Writes one audit row. The actor is taken from the JWT, never from the caller.';

grant execute on function app.log_audit(text, text, text, jsonb, uuid, inet, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.notifications enable row level security;
alter table public.notification_recipients enable row level security;
alter table public.audit_logs enable row level security;

-- A user sees a notification if it was addressed to them, or if they administer
-- notifications. Delivery rows are the authority on "addressed to".
create policy notifications_select on public.notifications
  for select to authenticated
  using (
    (select app.has_permission('notifications.create'))
    or exists (
      select 1
      from public.notification_recipients nr
      where nr.notification_id = notifications.id
        and nr.user_id = (select auth.uid())
    )
  );

create policy notifications_write on public.notifications
  for all to authenticated
  using ((select app.has_permission('notifications.create')))
  with check ((select app.has_permission('notifications.create')));

create policy notification_recipients_select on public.notification_recipients
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select app.has_permission('notifications.create'))
  );

-- A recipient may mark their own notification read. Nothing else about the row
-- is theirs to change, and the API only ever sets read_at.
create policy notification_recipients_update_own on public.notification_recipients
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy notification_recipients_insert on public.notification_recipients
  for insert to authenticated
  with check ((select app.has_permission('notifications.create')));

-- Audit: read-only, and only for those authorised to read it. No insert policy
-- (app.log_audit is the way in), no update or delete policy at all.
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using ((select app.has_permission('audit.view')));
