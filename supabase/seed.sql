-- ============================================================================
-- Seed data
-- ----------------------------------------------------------------------------
-- Run by `supabase db reset`. Idempotent, so it can be applied to an existing
-- database without duplicating anything.
--
-- Contains NO personal data. Members, users, and transactions are created
-- through the application.
--
-- Two placeholders are marked TODO because they are church facts I was not
-- given rather than defaults I should invent:
--   * the branch name and code
--   * finance.currency — seeded as an explicitly UNSET row, so the finance
--     module fails loudly rather than transacting in a guessed currency
--
-- The role → permission matrix below is BLUEPRINT.md §7.4. It is data, not
-- schema: correcting a cell is an UPDATE, not a migration.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Default branch  (TODO: replace with the real church branch name and code)
-- ---------------------------------------------------------------------------

insert into public.branches (code, name, country, timezone, is_active)
values ('MAIN', 'Main Branch', null, 'UTC', true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

insert into public.roles (key, name, description, is_system, sort_order)
values
  ('super_admin', 'Super Administrator', 'Full system access, including roles, settings, and branches.', true, 10),
  ('senior_pastor', 'Senior Pastor', 'Church-wide oversight and reporting; approves financial transactions.', true, 20),
  ('finance_officer', 'Finance Officer', 'Records and submits financial transactions. Cannot approve them.', true, 30),
  ('church_elder', 'Church Elder', 'Read-only oversight of members, ministries, attendance, and events.', true, 40),
  ('secretary', 'Secretary', 'Member, family, event, and attendance administration.', true, 50),
  ('ministry_leader', 'Ministry Leader', 'Manages the members, meetings, and events of the ministry they lead.', true, 60),
  ('choir_leader', 'Choir Leader', 'Ministry leader for the choir; same rights, scoped by leadership.', true, 70),
  ('media_team', 'Media Team', 'Event media and event detail maintenance.', true, 80),
  ('usher', 'Usher', 'Records service attendance and headcounts.', true, 90),
  ('member', 'Member', 'Access to their own profile and their own attendance history.', true, 100),
  ('guest', 'Guest', 'Public events only.', true, 110)
on conflict (key) do update
  set name = excluded.name,
      description = excluded.description,
      sort_order = excluded.sort_order,
      is_system = true;

-- ---------------------------------------------------------------------------
-- Permission catalogue
--
-- `resource` and `action` are derived from the key rather than typed out, so the
-- permissions_key_matches_parts constraint cannot be violated by a typo.
-- resource = everything before the last dot; action = everything after.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, resource, action, description)
select
  v.key,
  regexp_replace(v.key, '\.[^.]+$', ''),
  regexp_replace(v.key, '^.*\.', ''),
  v.description
from (
  values
    -- members
    ('members.view', 'View full member records in the branch.'),
    ('members.view_directory', 'View names and photos only, for attendance taking and lookup.'),
    ('members.create', 'Add a member to the roll.'),
    ('members.update', 'Edit member records, including membership status.'),
    ('members.delete', 'Remove a member from the roll, and restore one.'),
    ('members.export', 'Export member data in bulk.'),
    ('members.photo.manage', 'Upload and replace member photos.'),

    -- families
    ('families.view', 'View households and their members.'),
    ('families.create', 'Create a household.'),
    ('families.update', 'Edit households and their membership.'),
    ('families.delete', 'Delete a household.'),

    -- ministries
    ('ministries.view', 'View ministries in the branch.'),
    ('ministries.create', 'Create a ministry.'),
    ('ministries.update', 'Edit ministry details.'),
    ('ministries.delete', 'Delete a ministry.'),
    ('ministries.members.manage', 'Add and remove ministry members and appoint leaders.'),

    -- attendance
    ('attendance.view', 'View attendance sessions, records, and headcounts.'),
    ('attendance.session.create', 'Open an attendance session.'),
    ('attendance.session.close', 'Close a session, and reopen a closed one.'),
    ('attendance.record', 'Record attendance against an open session.'),
    ('attendance.update', 'Correct an attendance record.'),
    ('attendance.delete', 'Delete attendance records or a session.'),

    -- events
    ('events.view', 'View events in the branch.'),
    ('events.create', 'Create an event.'),
    ('events.update', 'Edit an event.'),
    ('events.delete', 'Delete an event.'),
    ('events.publish', 'Publish a draft event.'),
    ('events.attendance.manage', 'Manage event registrations and attendance.'),

    -- finance
    ('finance.view', 'View financial transactions and categories.'),
    ('finance.create', 'Record a financial transaction as a draft.'),
    ('finance.update', 'Edit a draft or rejected transaction.'),
    ('finance.submit', 'Submit a transaction for approval.'),
    ('finance.approve', 'Approve a submitted transaction so that it counts.'),
    ('finance.reject', 'Reject a submitted transaction back for correction.'),
    ('finance.void', 'Void an approved transaction, with a reason.'),
    ('finance.export', 'Export financial data in bulk.'),
    ('finance.categories.manage', 'Manage income and expense categories.'),

    -- reports
    ('reports.members.view', 'Member and new-member reports.'),
    ('reports.attendance.view', 'Attendance reports and statistics.'),
    ('reports.ministry.view', 'Ministry reports.'),
    ('reports.event.view', 'Event reports.'),
    ('reports.finance.view', 'Financial reports.'),

    -- users and roles
    ('users.view', 'View user accounts and their roles.'),
    ('users.invite', 'Invite a new user account.'),
    ('users.update', 'Edit user accounts and link them to member records.'),
    ('users.deactivate', 'Deactivate and reactivate user accounts.'),
    ('users.roles.manage', 'Grant and revoke role assignments.'),
    ('roles.manage', 'Create roles and change which permissions they carry.'),

    -- administration
    ('branches.view', 'View branch records.'),
    ('branches.manage', 'Create and edit branches, and move members between them.'),
    ('settings.view', 'View non-public settings.'),
    ('settings.manage', 'Change settings and reference lists.'),
    ('audit.view', 'Read the audit log.'),
    ('notifications.view', 'Receive in-app notifications.'),
    ('notifications.create', 'Publish notifications and announcements.')
) as v(key, description)
on conflict (key) do update set description = excluded.description;

-- ---------------------------------------------------------------------------
-- Role → permission matrix
--
-- super_admin is granted everything by definition, so it is expressed as a
-- cross join rather than a list that would need editing whenever a permission
-- is added.
-- ---------------------------------------------------------------------------

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.key = 'super_admin'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from (
  values
    -- ---- Senior Pastor: church-wide oversight; approves finance (D6) --------
    ('senior_pastor', 'members.view'),
    ('senior_pastor', 'members.view_directory'),
    ('senior_pastor', 'members.create'),
    ('senior_pastor', 'members.update'),
    ('senior_pastor', 'members.export'),
    ('senior_pastor', 'families.view'),
    ('senior_pastor', 'ministries.view'),
    ('senior_pastor', 'ministries.create'),
    ('senior_pastor', 'ministries.update'),
    ('senior_pastor', 'ministries.members.manage'),
    ('senior_pastor', 'attendance.view'),
    ('senior_pastor', 'attendance.session.create'),
    ('senior_pastor', 'attendance.session.close'),
    ('senior_pastor', 'attendance.record'),
    ('senior_pastor', 'events.view'),
    ('senior_pastor', 'events.create'),
    ('senior_pastor', 'events.update'),
    ('senior_pastor', 'events.publish'),
    ('senior_pastor', 'events.attendance.manage'),
    ('senior_pastor', 'finance.view'),
    ('senior_pastor', 'finance.approve'),
    ('senior_pastor', 'finance.reject'),
    ('senior_pastor', 'finance.void'),
    ('senior_pastor', 'reports.members.view'),
    ('senior_pastor', 'reports.attendance.view'),
    ('senior_pastor', 'reports.ministry.view'),
    ('senior_pastor', 'reports.event.view'),
    ('senior_pastor', 'reports.finance.view'),
    ('senior_pastor', 'users.view'),
    ('senior_pastor', 'branches.view'),
    ('senior_pastor', 'audit.view'),
    ('senior_pastor', 'notifications.view'),
    ('senior_pastor', 'notifications.create'),

    -- ---- Finance Officer: records and submits, never approves (D6) ---------
    -- members.view_directory rather than members.view: attributing a tithe
    -- needs a name, not a home address.
    ('finance_officer', 'members.view_directory'),
    ('finance_officer', 'events.view'),
    ('finance_officer', 'finance.view'),
    ('finance_officer', 'finance.create'),
    ('finance_officer', 'finance.update'),
    ('finance_officer', 'finance.submit'),
    ('finance_officer', 'finance.export'),
    ('finance_officer', 'finance.categories.manage'),
    ('finance_officer', 'reports.finance.view'),
    ('finance_officer', 'notifications.view'),

    -- ---- Church Elder: oversight, read-only --------------------------------
    ('church_elder', 'members.view'),
    ('church_elder', 'members.view_directory'),
    ('church_elder', 'families.view'),
    ('church_elder', 'ministries.view'),
    ('church_elder', 'attendance.view'),
    ('church_elder', 'events.view'),
    ('church_elder', 'reports.members.view'),
    ('church_elder', 'reports.attendance.view'),
    ('church_elder', 'reports.ministry.view'),
    ('church_elder', 'reports.event.view'),
    ('church_elder', 'notifications.view'),

    -- ---- Secretary: the day-to-day administrator ---------------------------
    ('secretary', 'members.view'),
    ('secretary', 'members.view_directory'),
    ('secretary', 'members.create'),
    ('secretary', 'members.update'),
    ('secretary', 'members.export'),
    ('secretary', 'members.photo.manage'),
    ('secretary', 'families.view'),
    ('secretary', 'families.create'),
    ('secretary', 'families.update'),
    ('secretary', 'families.delete'),
    ('secretary', 'ministries.view'),
    ('secretary', 'attendance.view'),
    ('secretary', 'attendance.session.create'),
    ('secretary', 'attendance.record'),
    ('secretary', 'events.view'),
    ('secretary', 'events.create'),
    ('secretary', 'events.update'),
    ('secretary', 'events.attendance.manage'),
    ('secretary', 'reports.members.view'),
    ('secretary', 'reports.attendance.view'),
    ('secretary', 'users.view'),
    ('secretary', 'branches.view'),
    ('secretary', 'notifications.view'),
    ('secretary', 'notifications.create'),

    -- ---- Ministry Leader ---------------------------------------------------
    -- Only READ permissions are granted branch-wide. Everything a leader DOES —
    -- managing their ministry's membership, opening its register, marking
    -- attendance, creating its events — comes from row-level leadership scope
    -- (app.is_ministry_leader / app.leads_session_ministry) instead.
    --
    -- This matters: granting `ministries.members.manage` or `attendance.record`
    -- branch-wide would let the choir leader add members to the ushering team
    -- and take the Sunday service register, which is exactly the over-reach the
    -- leadership model exists to prevent. An RLS test asserts this.
    ('ministry_leader', 'members.view_directory'),
    ('ministry_leader', 'ministries.view'),
    ('ministry_leader', 'events.view'),
    ('ministry_leader', 'reports.attendance.view'),
    ('ministry_leader', 'reports.ministry.view'),
    ('ministry_leader', 'notifications.view'),

    -- ---- Choir Leader: a ministry leader by another name -------------------
    ('choir_leader', 'members.view_directory'),
    ('choir_leader', 'ministries.view'),
    ('choir_leader', 'events.view'),
    ('choir_leader', 'reports.attendance.view'),
    ('choir_leader', 'reports.ministry.view'),
    ('choir_leader', 'notifications.view'),

    -- ---- Media Team --------------------------------------------------------
    ('media_team', 'members.view_directory'),
    ('media_team', 'events.view'),
    ('media_team', 'events.update'),
    ('media_team', 'events.attendance.manage'),
    ('media_team', 'notifications.view'),

    -- ---- Usher -------------------------------------------------------------
    -- attendance.view is branch-wide here rather than "own sessions only":
    -- session ownership is not modelled, and an usher who cannot see the
    -- register cannot use it. Flagged in BLUEPRINT.md Q1.
    ('usher', 'members.view_directory'),
    ('usher', 'attendance.view'),
    ('usher', 'attendance.session.create'),
    ('usher', 'attendance.record'),
    ('usher', 'events.view'),
    ('usher', 'notifications.view'),

    -- ---- Member ------------------------------------------------------------
    -- Everything a member may see is theirs by ownership, which the policies
    -- grant without a permission: their own profile, their own member record,
    -- their own attendance, their own household, and public events.
    -- Giving history is deliberately absent (decision D4).
    ('member', 'notifications.view')

    -- ---- Guest -------------------------------------------------------------
    -- No permissions at all. Public events are visible to any signed-in user
    -- through the events_select policy's is_public branch.
) as v(role_key, permission_key)
join public.roles r on r.key = v.role_key
join public.permissions p on p.key = v.permission_key
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Reference lists — all editable by administrators (settings.manage)
-- ---------------------------------------------------------------------------

insert into public.spiritual_gifts (name, sort_order)
select v.name, v.sort_order
from (
  values
    ('Administration', 10), ('Apostleship', 20), ('Discernment', 30), ('Encouragement', 40),
    ('Evangelism', 50), ('Faith', 60), ('Giving', 70), ('Healing', 80),
    ('Helps', 90), ('Hospitality', 100), ('Intercession', 110), ('Interpretation', 120),
    ('Knowledge', 130), ('Leadership', 140), ('Mercy', 150), ('Music', 160),
    ('Pastoring', 170), ('Prophecy', 180), ('Service', 190), ('Teaching', 200),
    ('Tongues', 210), ('Wisdom', 220)
) as v(name, sort_order)
on conflict (lower(btrim(name))) do nothing;

insert into public.event_categories (name, colour, sort_order)
select v.name, v.colour, v.sort_order
from (
  values
    ('Sunday Service', '#4f46e5', 10),
    ('Midweek Service', '#6366f1', 20),
    ('Prayer Meeting', '#0284c7', 30),
    ('Conference', '#7c3aed', 40),
    ('Outreach', '#059669', 50),
    ('Training', '#b45309', 60),
    ('Youth Programme', '#db2777', 70),
    ('Wedding', '#e11d48', 80),
    ('Funeral', '#475569', 90),
    ('Baptism', '#0891b2', 100),
    ('Meeting', '#64748b', 110),
    ('Other', '#94a3b8', 200)
) as v(name, colour, sort_order)
on conflict (lower(btrim(name))) do nothing;

insert into public.transaction_categories (kind, name, code, sort_order)
select v.kind::public.transaction_kind, v.name, v.code, v.sort_order
from (
  values
    ('income', 'Tithe', 'INC-TITHE', 10),
    ('income', 'Offering', 'INC-OFFER', 20),
    ('income', 'Thanksgiving Offering', 'INC-THANKS', 30),
    ('income', 'Special Offering', 'INC-SPECIAL', 40),
    ('income', 'Donation', 'INC-DONATE', 50),
    ('income', 'Building Fund', 'INC-BUILD', 60),
    ('income', 'Other Income', 'INC-OTHER', 200),
    ('expense', 'Utilities', 'EXP-UTIL', 10),
    ('expense', 'Salaries and Allowances', 'EXP-SALARY', 20),
    ('expense', 'Rent', 'EXP-RENT', 30),
    ('expense', 'Maintenance and Repairs', 'EXP-MAINT', 40),
    ('expense', 'Transport', 'EXP-TRANS', 50),
    ('expense', 'Outreach and Evangelism', 'EXP-OUTREACH', 60),
    ('expense', 'Missions', 'EXP-MISSION', 70),
    ('expense', 'Equipment', 'EXP-EQUIP', 80),
    ('expense', 'Hospitality', 'EXP-HOSP', 90),
    ('expense', 'Printing and Stationery', 'EXP-PRINT', 100),
    ('expense', 'Charity and Welfare', 'EXP-WELFARE', 110),
    ('expense', 'Other Expense', 'EXP-OTHER', 200)
) as v(kind, name, code, sort_order)
on conflict (kind, lower(btrim(name))) do nothing;

-- ---------------------------------------------------------------------------
-- Settings
--
-- finance.currency was seeded NULL until Q4c was answered, so the module would
-- refuse to transact rather than guess a currency and produce a ledger that is
-- quietly wrong. The owner has since chosen GHS (Ghana Cedi), so it is seeded
-- here. The finance service still fails loudly if it is ever unset again.
--
-- NOTE for an ALREADY-SEEDED database: the insert below is `on conflict ... do
-- nothing`, so it will NOT overwrite an existing (NULL) finance.currency row. A
-- database seeded before this change needs a one-off:
--   update public.settings set value = '"GHS"'::jsonb
--     where scope = 'global' and key = 'finance.currency';
-- or a full `npm run db:reset`.
-- ---------------------------------------------------------------------------

insert into public.settings (scope, key, value, description, is_public)
values
  ('global', 'church.name', '"Church Manager"'::jsonb,
    'TODO: replace with the real church name. Shown in the UI shell.', true),
  ('global', 'finance.currency', '"GHS"'::jsonb,
    'ISO 4217 code the finance ledger transacts in (Q4c: GHS). The service fails loudly if unset.', true),
  ('global', 'finance.approval_required', 'true'::jsonb,
    'Decision D3: every transaction requires approval. Informational; enforced in the schema.', false),
  ('global', 'members.number_prefix_source', '"branch_code"'::jsonb,
    'Member numbers are <branch code>-<six digits>.', false)
on conflict (key) where scope = 'global' do nothing;
