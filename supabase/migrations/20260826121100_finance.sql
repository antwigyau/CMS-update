-- ============================================================================
-- 0011 · Finance
-- ----------------------------------------------------------------------------
-- Decisions D3 and D6, implemented in the database rather than in application
-- code, because a financial control that only exists in the API layer is one
-- bug away from not existing.
--
--   D3  Every transaction — income AND expense — requires approval.
--       draft → pending_approval → approved, with rejected and void as the
--       other terminal states. ONLY 'approved' rows count toward any report.
--
--   D6  Senior Pastor and Super Administrator approve, reject, and void.
--       The Finance Officer records and submits. Nobody approves their own
--       entry: `transactions_no_self_approval` is what makes the second
--       signature real, since a Super Administrator holds both permissions and
--       the permission split alone would not stop them.
--
-- Three further invariants:
--   * financial fields are immutable once a row leaves draft/rejected —
--     correcting an amount means rejecting first, so the change is visible
--   * there is no DELETE policy at all; an approved transaction is reversed by
--     voiding it, which keeps the row and the reason
--   * `currency` has NO default. The application reads it from settings. A
--     guessed default currency is a silently wrong ledger.
-- ============================================================================

create table public.transaction_categories (
  id uuid primary key default gen_random_uuid(),
  kind public.transaction_kind not null,
  name text not null,
  code text,
  description text,
  is_active boolean not null default true,
  sort_order smallint not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint transaction_categories_name_length check (char_length(btrim(name)) between 2 and 80),
  constraint transaction_categories_code_format check (code is null or code ~ '^[A-Z][A-Z0-9_-]{1,15}$')
);

-- The same name may exist once for income and once for expense.
create unique index transaction_categories_kind_name_key
  on public.transaction_categories (kind, lower(btrim(name)));
create unique index transaction_categories_code_key
  on public.transaction_categories (code)
  where code is not null;
create index transaction_categories_kind_active_idx
  on public.transaction_categories (kind)
  where is_active;

create trigger transaction_categories_touch_updated_at
  before update on public.transaction_categories
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- transactions
--
-- One table with a `kind` discriminator rather than separate income/expense/
-- tithe/offering tables: every report in the specification needs both sides
-- together, and four tables would mean four policy sets, four validators, four
-- approval workflows, and a UNION in every query.
-- ---------------------------------------------------------------------------

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches (id) on delete restrict,
  kind public.transaction_kind not null,
  category_id uuid not null references public.transaction_categories (id) on delete restrict,
  -- Income only. Which sort of income this is: tithe, offering, donation, other.
  income_type public.income_type,
  -- Income only, and optional: an anonymous offering has no member.
  member_id uuid,

  amount numeric(14, 2) not null,
  currency char(3) not null,
  occurred_on date not null,
  payment_method public.payment_method not null,
  reference text,
  description text,
  receipt_path text,

  -- ---- approval lifecycle (D3) ----
  status public.transaction_status not null default 'draft',
  recorded_by uuid references auth.users (id) on delete set null,
  submitted_by uuid references auth.users (id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  rejected_by uuid references auth.users (id) on delete set null,
  rejected_at timestamptz,
  rejection_reason text,
  voided_by uuid references auth.users (id) on delete set null,
  voided_at timestamptz,
  void_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint transactions_member_fkey
    foreign key (member_id, branch_id) references public.members (id, branch_id) on delete set null,

  constraint transactions_amount_positive check (amount > 0),
  constraint transactions_currency_format check (app.is_valid_currency(currency)),
  constraint transactions_occurred_not_future check (occurred_on <= current_date),

  -- An expense has no income type and is never attributed to a member.
  constraint transactions_income_type_only_for_income check (
    kind = 'income' or income_type is null
  ),
  constraint transactions_income_type_required check (
    kind <> 'income' or income_type is not null
  ),
  constraint transactions_member_only_for_income check (
    member_id is null or kind = 'income'
  ),

  -- D6: the approver is never the submitter.
  constraint transactions_no_self_approval check (
    approved_by is null or submitted_by is null or approved_by <> submitted_by
  ),

  -- Each status carries the evidence that it happened.
  constraint transactions_submitted_complete check (
    status = 'draft' or (submitted_by is not null and submitted_at is not null)
  ),
  constraint transactions_approved_complete check (
    status <> 'approved' or (approved_by is not null and approved_at is not null)
  ),
  constraint transactions_rejected_complete check (
    status <> 'rejected'
    or (rejected_by is not null and rejected_at is not null
        and char_length(btrim(coalesce(rejection_reason, ''))) >= 3)
  ),
  constraint transactions_void_complete check (
    status <> 'void'
    or (voided_by is not null and voided_at is not null
        and char_length(btrim(coalesce(void_reason, ''))) >= 3)
  ),
  constraint transactions_reference_length check (reference is null or char_length(reference) <= 120),
  constraint transactions_description_length check (
    description is null or char_length(description) <= 2000
  )
);

-- ---- indexes --------------------------------------------------------------

-- The reporting index: one branch, approved rows, by date.
create index transactions_reporting_idx
  on public.transactions (branch_id, occurred_on desc)
  where status = 'approved';

create index transactions_branch_kind_idx
  on public.transactions (branch_id, kind, occurred_on desc)
  where status = 'approved';

-- The approval queue, which is now a routine weekly task (D3).
create index transactions_pending_idx
  on public.transactions (branch_id, submitted_at)
  where status = 'pending_approval';

create index transactions_category_id_idx on public.transactions (category_id);
create index transactions_member_id_idx on public.transactions (member_id)
  where member_id is not null;
create index transactions_status_idx on public.transactions (branch_id, status);

create trigger transactions_touch_updated_at
  before update on public.transactions
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- The state machine
--
-- Note the split: STRUCTURAL rules (valid transitions, field immutability) are
-- enforced unconditionally, including for the service-role key. PERMISSION
-- rules are skipped when there is no JWT, so a trusted backfill or migration can
-- write history without inventing a user — but it still cannot create an
-- impossible state.
-- ---------------------------------------------------------------------------

create or replace function app.guard_transaction_status() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_financial_change boolean;
begin
  if tg_op = 'INSERT' then
    -- A transaction is born as a draft or is submitted immediately; it cannot
    -- appear already approved.
    if new.status not in ('draft', 'pending_approval') then
      raise exception 'A transaction must be created as draft or pending_approval, not %', new.status
        using errcode = 'check_violation';
    end if;
    if v_actor is not null then
      new.recorded_by := coalesce(new.recorded_by, v_actor);
      if new.status = 'pending_approval' then
        -- Creating a row straight into the queue is still a submission, and
        -- needs the same permission as submitting an existing draft.
        if not app.has_permission_in('finance.submit', new.branch_id) then
          raise exception 'Submitting a transaction for approval requires the finance.submit permission'
            using errcode = 'insufficient_privilege';
        end if;
        new.submitted_by := coalesce(new.submitted_by, v_actor);
        new.submitted_at := coalesce(new.submitted_at, now());
      end if;
    end if;
    return new;
  end if;

  -- ---- structural: which transitions exist at all ----
  if old.status <> new.status then
    if not (
      (old.status = 'draft' and new.status = 'pending_approval')
      or (old.status = 'pending_approval' and new.status in ('approved', 'rejected'))
      or (old.status = 'rejected' and new.status in ('draft', 'pending_approval'))
      or (old.status = 'approved' and new.status = 'void')
    ) then
      raise exception 'A transaction cannot move from % to %', old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;

  -- ---- structural: financial fields are frozen after submission ----
  v_financial_change :=
    new.amount is distinct from old.amount
    or new.currency is distinct from old.currency
    or new.kind is distinct from old.kind
    or new.category_id is distinct from old.category_id
    or new.income_type is distinct from old.income_type
    or new.member_id is distinct from old.member_id
    or new.occurred_on is distinct from old.occurred_on
    or new.branch_id is distinct from old.branch_id;

  if v_financial_change and old.status not in ('draft', 'rejected') then
    raise exception
      'This transaction is % and its financial details are locked. Reject it first to make a correction.',
      old.status
      using errcode = 'restrict_violation';
  end if;

  -- ---- stamp the transition, so the API cannot forget to ----
  if old.status <> new.status then
    if new.status = 'pending_approval' then
      new.submitted_by := coalesce(v_actor, new.submitted_by, old.submitted_by);
      new.submitted_at := now();
      new.rejected_by := null;
      new.rejected_at := null;
      new.rejection_reason := null;
    elsif new.status = 'approved' then
      new.approved_by := coalesce(v_actor, new.approved_by);
      new.approved_at := now();
    elsif new.status = 'rejected' then
      new.rejected_by := coalesce(v_actor, new.rejected_by);
      new.rejected_at := now();
    elsif new.status = 'void' then
      new.voided_by := coalesce(v_actor, new.voided_by);
      new.voided_at := now();
    elsif new.status = 'draft' then
      new.submitted_by := null;
      new.submitted_at := null;
    end if;
  end if;

  -- ---- permissions: skipped only when there is no JWT at all ----
  if v_actor is null then
    return new;
  end if;

  if old.status <> new.status then
    if new.status = 'pending_approval'
       and not app.has_permission_in('finance.submit', new.branch_id) then
      raise exception 'Submitting a transaction for approval requires the finance.submit permission'
        using errcode = 'insufficient_privilege';
    end if;
    if new.status = 'approved'
       and not app.has_permission_in('finance.approve', new.branch_id) then
      raise exception 'Approving a transaction requires the finance.approve permission'
        using errcode = 'insufficient_privilege';
    end if;
    if new.status = 'rejected'
       and not app.has_permission_in('finance.reject', new.branch_id) then
      raise exception 'Rejecting a transaction requires the finance.reject permission'
        using errcode = 'insufficient_privilege';
    end if;
    if new.status = 'void'
       and not app.has_permission_in('finance.void', new.branch_id) then
      raise exception 'Voiding a transaction requires the finance.void permission'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

create trigger transactions_guard_status
  before insert or update on public.transactions
  for each row execute function app.guard_transaction_status();

-- ---------------------------------------------------------------------------
-- Reporting view
--
-- `security_invoker = true` so the caller's RLS applies — the view is a
-- convenience and a piece of documentation ("only approved rows count"), not a
-- way around access control.
-- ---------------------------------------------------------------------------

create view public.approved_transactions
with (security_invoker = true)
as
select
  t.id,
  t.branch_id,
  t.kind,
  t.category_id,
  c.name as category_name,
  t.income_type,
  t.member_id,
  t.amount,
  t.currency,
  t.occurred_on,
  t.payment_method,
  t.reference,
  t.description,
  t.approved_at
from public.transactions t
join public.transaction_categories c on c.id = t.category_id
where t.status = 'approved';

comment on view public.approved_transactions is
  'The only rows that count toward any financial report (decision D3).';

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.transaction_categories enable row level security;
alter table public.transactions enable row level security;

create policy transaction_categories_select on public.transaction_categories
  for select to authenticated
  using ((select app.has_permission('finance.view')));

create policy transaction_categories_write on public.transaction_categories
  for all to authenticated
  using ((select app.has_permission('finance.categories.manage')))
  with check ((select app.has_permission('finance.categories.manage')));

create policy transactions_select on public.transactions
  for select to authenticated
  using ((select app.has_permission_in('finance.view', branch_id)));

create policy transactions_insert on public.transactions
  for insert to authenticated
  with check ((select app.has_permission_in('finance.create', branch_id)));

-- One UPDATE policy covering edits, submission, approval, rejection, and
-- voiding. Which of those a given user may actually perform is decided by the
-- state-machine trigger, which can see the transition; a USING clause cannot.
create policy transactions_update on public.transactions
  for update to authenticated
  using (
    (select app.has_permission_in('finance.update', branch_id))
    or (select app.has_permission_in('finance.submit', branch_id))
    or (select app.has_permission_in('finance.approve', branch_id))
    or (select app.has_permission_in('finance.reject', branch_id))
    or (select app.has_permission_in('finance.void', branch_id))
  )
  with check (
    (select app.has_permission_in('finance.update', branch_id))
    or (select app.has_permission_in('finance.submit', branch_id))
    or (select app.has_permission_in('finance.approve', branch_id))
    or (select app.has_permission_in('finance.reject', branch_id))
    or (select app.has_permission_in('finance.void', branch_id))
  );

-- No DELETE policy, for anyone, ever. Reversal is `void`.
