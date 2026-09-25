/**
 * Constraint, index, and generated-column behaviour.
 *
 * These run as the table owner, so RLS is out of the picture — the question here
 * is whether the database itself refuses bad data. Anything enforced by a
 * trigger that consults the caller's permissions is tested in rls.test.js and
 * finance.test.js instead, because those triggers deliberately stand aside when
 * there is no JWT.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createMember, createTestDatabase, defaultBranchId } from './harness.js';

let db;
let branchId;

before(async () => {
  db = await createTestDatabase();
  branchId = await defaultBranchId(db);
});

after(async () => {
  await db?.close();
});

describe('members: generated columns', () => {
  it('assigns a member number as <branch code>-<six digits>', async () => {
    const id = await createMember(db, { branchId, firstName: 'Grace', lastName: 'Mensah' });
    const row = await db.one(`select member_no, full_name from public.members where id = $1`, [id]);

    assert.match(row.member_no, /^MAIN-\d{6}$/);
    assert.equal(row.full_name, 'Grace Mensah');
  });

  it('includes a middle name in full_name without leaving double spaces', async () => {
    const id = await createMember(db, {
      branchId,
      firstName: 'Daniel',
      lastName: 'Osei',
      middle_name: 'Kwabena',
    });
    assert.equal(
      await db.value(`select full_name from public.members where id = $1`, [id]),
      'Daniel Kwabena Osei',
    );
  });

  it('builds a search vector covering name, member number, email and phone', async () => {
    const id = await createMember(db, {
      branchId,
      firstName: 'Abena',
      lastName: 'Owusu',
      email: 'abena@example.com',
      phone: '+233201234567',
    });

    const hits = await db.value(
      `select count(*)::int from public.members
       where id = $1 and search_vector @@ plainto_tsquery('simple', 'Owusu')`,
      [id],
    );
    assert.equal(Number(hits), 1);

    const byNumber = await db.value(
      `select count(*)::int from public.members m
       where m.id = $1 and m.search_vector @@ plainto_tsquery('simple', m.member_no)`,
      [id],
    );
    assert.equal(Number(byNumber), 1);
  });

  it('refuses a member number that does not match the format', async () => {
    const error = await db.expectRejection(
      `insert into public.members (branch_id, member_no, first_name, last_name)
       values ($1, 'nope', 'A', 'B')`,
      [branchId],
    );
    assert.match(error.message, /members_member_no_format/);
  });
});

describe('members: data integrity', () => {
  it('rejects a date of birth in the future', async () => {
    const error = await db.expectRejection(
      `insert into public.members (branch_id, first_name, last_name, date_of_birth)
       values ($1, 'Future', 'Person', current_date + 1)`,
      [branchId],
    );
    assert.match(error.message, /members_dob_not_future/);
  });

  it('rejects a baptism date when the member is not recorded as baptised', async () => {
    const error = await db.expectRejection(
      `insert into public.members (branch_id, first_name, last_name, is_baptized, baptism_date)
       values ($1, 'Not', 'Baptised', false, current_date - 30)`,
      [branchId],
    );
    assert.match(error.message, /members_baptism_consistent/);
  });

  it('rejects a baptism date before the date of birth', async () => {
    const error = await db.expectRejection(
      `insert into public.members (branch_id, first_name, last_name, date_of_birth, is_baptized, baptism_date)
       values ($1, 'Time', 'Traveller', '2000-01-01', true, '1999-01-01')`,
      [branchId],
    );
    assert.match(error.message, /members_baptism_consistent/);
  });

  it('rejects a malformed email', async () => {
    const error = await db.expectRejection(
      `insert into public.members (branch_id, first_name, last_name, email)
       values ($1, 'Bad', 'Email', 'not-an-email')`,
      [branchId],
    );
    assert.match(error.message, /members_email_valid/);
  });

  it('prevents two live members in a branch sharing an email', async () => {
    await createMember(db, {
      branchId,
      firstName: 'First',
      lastName: 'Claim',
      email: 'shared@example.com',
    });
    const error = await db.expectRejection(
      `insert into public.members (branch_id, first_name, last_name, email)
       values ($1, 'Second', 'Claim', 'shared@example.com')`,
      [branchId],
    );
    assert.match(error.message, /members_branch_email_key/);
  });

  it('frees that email again once the member is soft-deleted', async () => {
    await db.sql(`update public.members set deleted_at = now() where email = 'shared@example.com'`);
    const id = await createMember(db, {
      branchId,
      firstName: 'Third',
      lastName: 'Claim',
      email: 'shared@example.com',
    });
    assert.ok(id, 'a soft-deleted row must not hold an email hostage');
  });
});

describe('cross-branch integrity', () => {
  let otherBranchId;
  let memberInMain;
  let memberInOther;

  before(async () => {
    otherBranchId = await db.value(
      `insert into public.branches (code, name) values ('WEST', 'West Branch') returning id`,
    );
    memberInMain = await createMember(db, { branchId, firstName: 'Main', lastName: 'Member' });
    memberInOther = await createMember(db, {
      branchId: otherBranchId,
      firstName: 'West',
      lastName: 'Member',
    });
  });

  it('numbers members using their own branch code', async () => {
    assert.match(
      await db.value(`select member_no from public.members where id = $1`, [memberInOther]),
      /^WEST-/,
    );
  });

  it('refuses to put a member from another branch into a family', async () => {
    const familyId = await db.value(
      `insert into public.families (branch_id, family_name) values ($1, 'Mensah Household') returning id`,
      [branchId],
    );

    // Claiming the family's branch does not help: the member FK then fails.
    const error = await db.expectRejection(
      `insert into public.family_members (family_id, member_id, branch_id, relationship)
       values ($1, $2, $3, 'head')`,
      [familyId, memberInOther, branchId],
    );
    assert.match(error.message, /family_members_member_fkey/);
  });

  it('refuses to put a member from another branch into a ministry', async () => {
    const ministryId = await db.value(
      `insert into public.ministries (branch_id, name) values ($1, 'Choir') returning id`,
      [branchId],
    );
    const error = await db.expectRejection(
      `insert into public.ministry_members (ministry_id, member_id, branch_id)
       values ($1, $2, $3)`,
      [ministryId, memberInOther, branchId],
    );
    assert.match(error.message, /ministry_members_member_fkey/);
  });

  it('accepts the same insert when the member is in the right branch', async () => {
    const ministryId = await db.value(
      `select id from public.ministries where branch_id = $1 and name = 'Choir'`,
      [branchId],
    );
    await db.sql(
      `insert into public.ministry_members (ministry_id, member_id, branch_id, role_in_ministry)
       values ($1, $2, $3, 'member')`,
      [ministryId, memberInMain, branchId],
    );
    assert.equal(
      Number(
        await db.value(`select count(*)::int from public.ministry_members where ministry_id = $1`, [
          ministryId,
        ]),
      ),
      1,
    );
  });
});

describe('families', () => {
  let familyId;
  let a;
  let b;

  before(async () => {
    familyId = await db.value(
      `insert into public.families (branch_id, family_name) values ($1, 'Osei Household') returning id`,
      [branchId],
    );
    a = await createMember(db, { branchId, firstName: 'Head', lastName: 'Osei' });
    b = await createMember(db, { branchId, firstName: 'Spouse', lastName: 'Osei' });
    await db.sql(
      `insert into public.family_members (family_id, member_id, branch_id, relationship)
       values ($1, $2, $3, 'head')`,
      [familyId, a, branchId],
    );
  });

  it('allows only one head per family', async () => {
    const error = await db.expectRejection(
      `insert into public.family_members (family_id, member_id, branch_id, relationship)
       values ($1, $2, $3, 'head')`,
      [familyId, b, branchId],
    );
    assert.match(error.message, /family_members_one_head/);
  });

  it('allows other relationships alongside the head', async () => {
    await db.sql(
      `insert into public.family_members (family_id, member_id, branch_id, relationship)
       values ($1, $2, $3, 'spouse')`,
      [familyId, b, branchId],
    );
    assert.equal(
      Number(
        await db.value(`select count(*)::int from public.family_members where family_id = $1`, [
          familyId,
        ]),
      ),
      2,
    );
  });

  it('keeps a member in at most one household', async () => {
    const otherFamily = await db.value(
      `insert into public.families (branch_id, family_name) values ($1, 'Second Household') returning id`,
      [branchId],
    );
    const error = await db.expectRejection(
      `insert into public.family_members (family_id, member_id, branch_id, relationship)
       values ($1, $2, $3, 'other')`,
      [otherFamily, a, branchId],
    );
    assert.match(error.message, /family_members_one_household/);
  });
});

describe('ministries', () => {
  let ministryId;

  before(async () => {
    ministryId = await db.value(
      `insert into public.ministries (branch_id, name) values ($1, 'Ushering') returning id`,
      [branchId],
    );
  });

  it('allows one active leader at a time', async () => {
    const first = await createMember(db, { branchId, firstName: 'Lead', lastName: 'One' });
    const second = await createMember(db, { branchId, firstName: 'Lead', lastName: 'Two' });

    await db.sql(
      `insert into public.ministry_members (ministry_id, member_id, branch_id, role_in_ministry)
       values ($1, $2, $3, 'leader')`,
      [ministryId, first, branchId],
    );

    const error = await db.expectRejection(
      `insert into public.ministry_members (ministry_id, member_id, branch_id, role_in_ministry)
       values ($1, $2, $3, 'leader')`,
      [ministryId, second, branchId],
    );
    assert.match(error.message, /ministry_members_one_active_leader/);
  });

  it('frees the leadership slot once the previous leader has left', async () => {
    await db.sql(
      `update public.ministry_members set left_on = current_date
       where ministry_id = $1 and role_in_ministry = 'leader'`,
      [ministryId],
    );
    const third = await createMember(db, { branchId, firstName: 'Lead', lastName: 'Three' });
    await db.sql(
      `insert into public.ministry_members (ministry_id, member_id, branch_id, role_in_ministry)
       values ($1, $2, $3, 'leader')`,
      [ministryId, third, branchId],
    );
    assert.equal(
      Number(
        await db.value(
          `select count(*)::int from public.ministry_members
           where ministry_id = $1 and role_in_ministry = 'leader' and left_on is null`,
          [ministryId],
        ),
      ),
      1,
    );
  });

  it('rejects a leaving date before the joining date', async () => {
    const member = await createMember(db, { branchId, firstName: 'Odd', lastName: 'Dates' });
    const error = await db.expectRejection(
      `insert into public.ministry_members (ministry_id, member_id, branch_id, joined_on, left_on)
       values ($1, $2, $3, current_date, current_date - 5)`,
      [ministryId, member, branchId],
    );
    assert.match(error.message, /ministry_members_dates/);
  });
});

describe('attendance sessions', () => {
  it('computes the headcount total from its parts (decision D5)', async () => {
    const id = await db.value(
      `insert into public.attendance_sessions
         (branch_id, session_type, title, session_date, count_adults, count_youth, count_children, count_visitors)
       values ($1, 'service', 'First Service', current_date, 120, 40, 45, 7)
       returning id`,
      [branchId],
    );
    assert.equal(
      Number(
        await db.value(`select count_total from public.attendance_sessions where id = $1`, [id]),
      ),
      212,
    );
  });

  it('does not require the headcount to agree with the named records', async () => {
    const sessionId = await db.value(
      `insert into public.attendance_sessions (branch_id, session_type, title, session_date, count_adults)
       values ($1, 'service', 'Reconciliation Service', current_date, 200) returning id`,
      [branchId],
    );
    const member = await createMember(db, { branchId, firstName: 'Named', lastName: 'Attendee' });
    await db.sql(
      `insert into public.attendance_records (session_id, branch_id, member_id) values ($1, $2, $3)`,
      [sessionId, branchId, member],
    );

    // 200 counted, 1 identified. Both are correct; reconciling them is a human task.
    const row = await db.one(
      `select s.count_total, (select count(*) from public.attendance_records r where r.session_id = s.id) as named
       from public.attendance_sessions s where s.id = $1`,
      [sessionId],
    );
    assert.equal(Number(row.count_total), 200);
    assert.equal(Number(row.named), 1);
  });

  it('refuses a negative headcount', async () => {
    const error = await db.expectRejection(
      `insert into public.attendance_sessions (branch_id, session_type, title, session_date, count_adults)
       values ($1, 'service', 'Negative Service', current_date, -1)`,
      [branchId],
    );
    assert.match(error.message, /counts_non_negative/);
  });

  it('refuses a service session that points at a ministry', async () => {
    const ministryId = await db.value(`select id from public.ministries where name = 'Ushering'`);
    const error = await db.expectRejection(
      `insert into public.attendance_sessions (branch_id, session_type, title, session_date, ministry_id)
       values ($1, 'service', 'Confused Session', current_date, $2)`,
      [branchId, ministryId],
    );
    assert.match(error.message, /type_reference/);
  });

  it('requires a ministry session to name its ministry', async () => {
    const error = await db.expectRejection(
      `insert into public.attendance_sessions (branch_id, session_type, title, session_date)
       values ($1, 'ministry', 'Orphan Ministry Session', current_date)`,
      [branchId],
    );
    assert.match(error.message, /type_reference/);
  });

  it('prevents two service registers for the same day and title', async () => {
    await db.sql(
      `insert into public.attendance_sessions (branch_id, session_type, title, session_date)
       values ($1, 'service', 'Evening Service', current_date - 7)`,
      [branchId],
    );
    const error = await db.expectRejection(
      `insert into public.attendance_sessions (branch_id, session_type, title, session_date)
       values ($1, 'service', 'evening service', current_date - 7)`,
      [branchId],
    );
    assert.match(error.message, /attendance_sessions_service_key/);
  });

  it('requires an attendance record to name either a member or a guest', async () => {
    const sessionId = await db.value(
      `insert into public.attendance_sessions (branch_id, session_type, title, session_date)
       values ($1, 'service', 'Guest Service', current_date - 14) returning id`,
      [branchId],
    );
    const error = await db.expectRejection(
      `insert into public.attendance_records (session_id, branch_id) values ($1, $2)`,
      [sessionId, branchId],
    );
    assert.match(error.message, /attendance_records_subject/);
  });

  it('records a member at most once per session', async () => {
    const sessionId = await db.value(
      `insert into public.attendance_sessions (branch_id, session_type, title, session_date)
       values ($1, 'service', 'Duplicate Service', current_date - 21) returning id`,
      [branchId],
    );
    const member = await createMember(db, { branchId, firstName: 'Twice', lastName: 'Counted' });
    await db.sql(
      `insert into public.attendance_records (session_id, branch_id, member_id) values ($1,$2,$3)`,
      [sessionId, branchId, member],
    );
    const error = await db.expectRejection(
      `insert into public.attendance_records (session_id, branch_id, member_id) values ($1,$2,$3)`,
      [sessionId, branchId, member],
    );
    assert.match(error.message, /attendance_records_member_key/);
  });
});

describe('events', () => {
  it('requires the end to follow the start', async () => {
    const error = await db.expectRejection(
      `insert into public.events (branch_id, title, starts_at, ends_at)
       values ($1, 'Backwards Event', now(), now() - interval '1 hour')`,
      [branchId],
    );
    assert.match(error.message, /events_ends_after_starts/);
  });

  it('requires a registration to name either a member or a guest, not both', async () => {
    const eventId = await db.value(
      `insert into public.events (branch_id, title, starts_at, ends_at)
       values ($1, 'Outreach', now() + interval '1 day', now() + interval '2 days') returning id`,
      [branchId],
    );
    const member = await createMember(db, { branchId, firstName: 'Reg', lastName: 'Istrant' });

    const error = await db.expectRejection(
      `insert into public.event_registrations (event_id, branch_id, member_id, guest_name)
       values ($1, $2, $3, 'Also A Guest')`,
      [eventId, branchId, member],
    );
    assert.match(error.message, /event_registrations_subject/);
  });
});

describe('notifications', () => {
  it('rejects an absolute link, so a notification cannot be a phishing vector', async () => {
    const error = await db.expectRejection(
      `insert into public.notifications (title, body, link_path)
       values ('Update', 'Please sign in', 'https://evil.example/login')`,
    );
    assert.match(error.message, /notifications_link_relative/);
  });

  it('accepts a relative link', async () => {
    const id = await db.value(
      `insert into public.notifications (title, body, link_path)
       values ('New event', 'A new event was published', '/events') returning id`,
    );
    assert.ok(id);
  });

  it('requires a role when the audience is a role', async () => {
    const error = await db.expectRejection(
      `insert into public.notifications (title, body, audience)
       values ('Role note', 'For one role', 'role')`,
    );
    assert.match(error.message, /notifications_audience_role/);
  });
});

describe('audit log immutability', () => {
  before(async () => {
    await db.sql(
      `select app.log_audit('member.created', 'member', 'abc', '{"first_name":"Grace"}'::jsonb)`,
    );
  });

  it('records the row', async () => {
    assert.ok(Number(await db.value(`select count(*)::int from public.audit_logs`)) >= 1);
  });

  it('cannot be updated, even by the table owner', async () => {
    const error = await db.expectRejection(
      `update public.audit_logs set action = 'member.tampered'`,
    );
    assert.match(error.message, /cannot be update/);
  });

  it('cannot be deleted, even by the table owner', async () => {
    const error = await db.expectRejection(`delete from public.audit_logs`);
    assert.match(error.message, /cannot be delete/);
  });

  it('redacts credential-shaped keys before writing them', async () => {
    await db.sql(
      `select app.log_audit('user.updated', 'user', 'u1', '{"email":"a@b.c","password":"hunter2","access_token":"xyz"}'::jsonb)`,
    );
    const row = await db.one(
      `select changes from public.audit_logs where action = 'user.updated' order by id desc limit 1`,
    );
    assert.equal(row.changes.email, 'a@b.c');
    assert.equal(row.changes.password, '[redacted]');
    assert.equal(row.changes.access_token, '[redacted]');
  });

  it('rejects a malformed action name', async () => {
    const error = await db.expectRejection(
      `insert into public.audit_logs (action, resource_type) values ('Deleted Everything', 'member')`,
    );
    assert.match(error.message, /audit_logs_action_format/);
  });
});
