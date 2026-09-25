-- ============================================================================
-- 0002 · Enumerated types
-- ----------------------------------------------------------------------------
-- Enums rather than lookup tables wherever the set of values is fixed by the
-- data model rather than by church policy. Adding a value later is
-- `alter type ... add value`, which is cheap; removing one is not, so each enum
-- starts with the smallest defensible set.
--
-- Where the values ARE church policy and will be edited by administrators
-- (transaction categories, event categories, spiritual gifts, ministries), a
-- lookup TABLE is used instead. That distinction is deliberate.
-- ============================================================================

-- ---- people ---------------------------------------------------------------

create type public.gender as enum ('male', 'female');

create type public.marital_status as enum ('single', 'married', 'widowed', 'divorced', 'separated');

create type public.membership_status as enum (
  'visitor',
  'new',
  'active',
  'inactive',
  'transferred',
  'deceased'
);

create type public.family_relationship as enum (
  'head',
  'spouse',
  'son',
  'daughter',
  'father',
  'mother',
  'brother',
  'sister',
  'grandparent',
  'grandchild',
  'other'
);

-- ---- ministries -----------------------------------------------------------

create type public.ministry_status as enum ('active', 'inactive');

create type public.ministry_role as enum ('leader', 'assistant_leader', 'member');

-- ---- attendance -----------------------------------------------------------

create type public.session_type as enum ('service', 'event', 'ministry');

create type public.session_status as enum ('open', 'closed');

create type public.attendance_status as enum ('present', 'absent', 'late', 'excused');

-- 'qr' exists in the enum but no scanner ships in the MVP; the column is ready
-- so that adding one later needs no migration.
create type public.attendance_method as enum ('manual', 'search', 'qr');

-- ---- events ---------------------------------------------------------------

create type public.event_status as enum (
  'draft',
  'published',
  'ongoing',
  'completed',
  'cancelled'
);

create type public.registration_status as enum ('registered', 'cancelled', 'no_show');

-- ---- finance --------------------------------------------------------------

create type public.transaction_kind as enum ('income', 'expense');

create type public.income_type as enum ('tithe', 'offering', 'donation', 'other');

create type public.payment_method as enum (
  'cash',
  'mobile_money',
  'bank_transfer',
  'cheque',
  'card',
  'other'
);

-- The approval lifecycle from decision D3. Only 'approved' rows count toward
-- any report; see 20260826121100_finance.sql for the state machine.
create type public.transaction_status as enum (
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'void'
);

-- ---- cross-cutting --------------------------------------------------------

create type public.notification_type as enum ('system', 'announcement', 'event_reminder', 'admin');

create type public.notification_severity as enum ('info', 'warning', 'critical');

create type public.notification_audience as enum ('all', 'role', 'branch', 'user');

create type public.settings_scope as enum ('global', 'branch');
