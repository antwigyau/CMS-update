/**
 * Row Level Security, exercised as each role.
 *
 * This is the file that matters. Every test here runs as `authenticated` with a
 * real `sub` claim, against Supabase's own default table grants — so a policy
 * that fails to restrict shows up as data appearing where it should not, exactly
 * as it would in production.
 *
 * A passing "cannot see" assertion is only meaningful because the corresponding
 * "can see" assertion also passes: together they prove the policy discriminates
 * rather than simply denying everyone.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createMember, createTestDatabase, createUser, defaultBranchId } from './harness.js';

let db;
let mainBranch;
let westBranch;

const users = {};
const members = {};
let choirId;

before(async () => {
  db = await createTestDatabase();
  mainBranch = await defaultBranchId(db);
  westBranch = await db.value(
    `insert into public.branches (code, name) values ('WEST', 'West Branch') returning id`,
  );

  // ---- staff -------------------------------------------------------------
  users.superAdmin = await createUser(db, { email: 'super@church.test', roles: ['super_admin'] });
  users.pastor = await createUser(db, { email: 'pastor@church.test', roles: ['senior_pastor'] });
  users.finance = await createUser(db, {
    email: 'finance@church.test',
    roles: ['finance_officer'],
  });
  users.secretary = await createUser(db, {
    email: 'secretary@church.test',
    roles: ['secretary'],
    branchId: mainBranch,
  });
  users.elder = await createUser(db, {
    email: 'elder@church.test',
    roles: ['church_elder'],
    branchId: mainBranch,
  });
  users.usher = await createUser(db, {
    email: 'usher@church.test',
    roles: ['usher'],
    branchId: mainBranch,
  });
  users.westSecretary = await createUser(db, {
    email: 'west@church.test',
    roles: ['secretary'],
    branchId: westBranch,
  });
  users.suspended = await createUser(db, {
    email: 'suspended@church.test',
    roles: ['secretary'],
    branchId: mainBranch,
    isActive: false,
  });

  // ---- members with logins ------------------------------------------------
  users.leader = await createUser(db, {
    email: 'leader@church.test',
    roles: ['ministry_leader'],
    branchId: mainBranch,
  });
  users.congregant = await createUser(db, {
    email: 'congregant@church.test',
    roles: ['member'],
    branchId: mainBranch,
  });

  members.leader = await createMember(db, {
    branchId: mainBranch,
    firstName: 'Esi',
    lastName: 'Boateng',
    userId: users.leader,
  });
  members.congregant = await createMember(db, {
    branchId: mainBranch,
    firstName: 'Kofi',
    lastName: 'Annan',
    userId: users.congregant,
  });
  members.choirSinger = await createMember(db, {
    branchId: mainBranch,
    firstName: 'Adjoa',
    lastName: 'Nyarko',
  });
  members.stranger = await createMember(db, {
    branchId: mainBranch,
    firstName: 'Yaw',
    lastName: 'Darko',
  });
  members.westMember = await createMember(db, {
    branchId: westBranch,
    firstName: 'West',
    lastName: 'Resident',
  });

  // The leader leads the choir; the singer is in it. The stranger is not.
  choirId = await db.value(
    `insert into public.ministries (branch_id, name) values ($1, 'Choir') returning id`,
    [mainBranch],
  );
  await db.sql(
    `insert into public.ministry_members (ministry_id, member_id, branch_id, role_in_ministry)
     values ($1, $2, $3, 'leader'), ($1, $4, $3, 'member')`,
    [choirId, members.leader, mainBranch, members.choirSinger],
  );
});

after(async () => {
  await db?.close();
});

/* -------------------------------------------------------------------------- */

describe('unauthenticated access', () => {
  it('sees no members, despite the table grants Supabase hands to anon', async () => {
    await db.asAnon(async () => {
      assert.equal(await db.visibleCount('public.members'), 0);
    });
  });

  it('sees no financial data and no audit log', async () => {
    await db.asAnon(async () => {
      assert.equal(await db.visibleCount('public.transactions'), 0);
      assert.equal(await db.visibleCount('public.audit_logs'), 0);
      assert.equal(await db.visibleCount('public.profiles'), 0);
    });
  });

  it('cannot insert a member', async () => {
    await db.asAnon(async () => {
      const error = await db.expectRejection(
        `insert into public.members (branch_id, first_name, last_name) values ($1, 'Anon', 'Insert')`,
        [mainBranch],
      );
      assert.match(error.message, /row-level security/i);
    });
  });
});

describe('deactivated accounts', () => {
  it('lose data access immediately, even though the role grant is still there', async () => {
    const grants = await db.value(
      `select count(*)::int from public.user_roles where user_id = $1`,
      [users.suspended],
    );
    assert.equal(Number(grants), 1, 'the grant is intact...');

    await db.asUser(users.suspended, async () => {
      // ...but every helper checks profiles.is_active, so it buys nothing.
      assert.equal(await db.visibleCount('public.members'), 0);
      assert.equal(await db.value(`select app.has_permission('members.view')`), false);
    });
  });
});

describe('branch scoping', () => {
  it('lets a Main Branch secretary see Main Branch members only', async () => {
    await db.asUser(users.secretary, async () => {
      const rows = await db.sql(`select branch_id from public.members`);
      assert.ok(rows.length >= 4, 'should see the Main Branch roll');
      assert.ok(
        rows.every((row) => row.branch_id === mainBranch),
        'no member from another branch may appear',
      );
    });
  });

  it('lets a West Branch secretary see West Branch members only', async () => {
    await db.asUser(users.westSecretary, async () => {
      const rows = await db.sql(`select id, branch_id from public.members`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, members.westMember);
    });
  });

  it('refuses a secretary who tries to create a member in another branch', async () => {
    await db.asUser(users.secretary, async () => {
      const error = await db.expectRejection(
        `insert into public.members (branch_id, first_name, last_name) values ($1, 'Cross', 'Branch')`,
        [westBranch],
      );
      assert.match(error.message, /row-level security/i);
    });
  });

  it('gives a globally-granted role every branch', async () => {
    await db.asUser(users.pastor, async () => {
      const branches = await db.sql(`select distinct branch_id from public.members`);
      assert.equal(branches.length, 2);
    });
  });
});

describe('the restricted directory', () => {
  it('gives an usher no access to the members table at all', async () => {
    await db.asUser(users.usher, async () => {
      assert.equal(await db.visibleCount('public.members'), 0);
    });
  });

  it('but lets them look up names and photos through the directory function', async () => {
    await db.asUser(users.usher, async () => {
      const rows = await db.sql(`select * from public.search_member_directory($1, null, 50, 0)`, [
        mainBranch,
      ]);
      assert.ok(rows.length >= 4, 'an usher must be able to find people to mark present');
      assert.deepEqual(Object.keys(rows[0]).sort(), [
        'full_name',
        'id',
        'member_no',
        'membership_status',
        'photo_path',
      ]);
    });
  });

  it('returns nothing from the directory for a branch the caller has no role in', async () => {
    await db.asUser(users.usher, async () => {
      const rows = await db.sql(`select * from public.search_member_directory($1, null, 50, 0)`, [
        westBranch,
      ]);
      assert.deepEqual(rows, []);
    });
  });

  it('refuses the directory entirely to a plain member', async () => {
    await db.asUser(users.congregant, async () => {
      const rows = await db.sql(`select * from public.search_member_directory($1, null, 50, 0)`, [
        mainBranch,
      ]);
      assert.deepEqual(rows, []);
    });
  });

  it('caps the page size server-side, so the whole roll cannot be pulled in one call', async () => {
    await db.asUser(users.secretary, async () => {
      const rows = await db.sql(
        `select * from public.search_member_directory($1, null, 100000, 0)`,
        [mainBranch],
      );
      assert.ok(rows.length <= 100);
    });
  });

  it('searches by name', async () => {
    await db.asUser(users.usher, async () => {
      const rows = await db.sql(
        `select full_name from public.search_member_directory($1, 'Nyarko', 25, 0)`,
        [mainBranch],
      );
      assert.deepEqual(
        rows.map((row) => row.full_name),
        ['Adjoa Nyarko'],
      );
    });
  });
});

describe('a member with a login', () => {
  it('sees their own record and nobody else’s', async () => {
    await db.asUser(users.congregant, async () => {
      const rows = await db.sql(`select id from public.members`);
      assert.deepEqual(
        rows.map((row) => row.id),
        [members.congregant],
      );
    });
  });

  it('can correct their own contact details', async () => {
    await db.asUser(users.congregant, async () => {
      await db.sql(`update public.members set phone = '+233555000111' where id = $1`, [
        members.congregant,
      ]);
    });
    assert.equal(
      await db.value(`select phone from public.members where id = $1`, [members.congregant]),
      '+233555000111',
    );
  });

  it('cannot promote their own membership status', async () => {
    await db.asUser(users.congregant, async () => {
      const error = await db.expectRejection(
        `update public.members set membership_status = 'active' where id = $1`,
        [members.congregant],
      );
      assert.match(error.message, /membership status requires the members.update permission/);
    });
  });

  it('cannot move themselves to another branch', async () => {
    await db.asUser(users.congregant, async () => {
      const error = await db.expectRejection(
        `update public.members set branch_id = $1 where id = $2`,
        [westBranch, members.congregant],
      );
      assert.match(error.message, /branches.manage/);
    });
  });

  it('cannot remove themselves from the roll', async () => {
    await db.asUser(users.congregant, async () => {
      const error = await db.expectRejection(
        `update public.members set deleted_at = now() where id = $1`,
        [members.congregant],
      );
      assert.match(error.message, /members.delete/);
    });
  });

  it('cannot claim another member record by pointing it at themselves', async () => {
    await db.asUser(users.congregant, async () => {
      // Not an error: the row is invisible to them, so the UPDATE simply matches
      // nothing. Silent no-op is the correct RLS outcome for a hidden row — the
      // assertion that matters is that the link was not made.
      await db.sql(`update public.members set user_id = $1 where id = $2`, [
        users.congregant,
        members.stranger,
      ]);
    });

    assert.equal(
      await db.value(`select user_id from public.members where id = $1`, [members.stranger]),
      null,
    );
  });
});

describe('ministry leadership scope', () => {
  it('lets a leader see the members of the ministry they lead', async () => {
    await db.asUser(users.leader, async () => {
      const rows = await db.sql(`select id from public.members order by id`);
      const visible = new Set(rows.map((row) => row.id));

      assert.ok(
        visible.has(members.choirSinger),
        'a choir member must be visible to the choir leader',
      );
      assert.ok(visible.has(members.leader), 'their own record');
      assert.ok(!visible.has(members.stranger), 'someone not in their ministry must not be');
      assert.ok(!visible.has(members.westMember), 'nor anyone in another branch');
    });
  });

  it('does not extend that scope to a member who has left the ministry', async () => {
    await db.sql(
      `update public.ministry_members set left_on = current_date
       where ministry_id = $1 and member_id = $2`,
      [choirId, members.choirSinger],
    );

    await db.asUser(users.leader, async () => {
      const rows = await db.sql(`select id from public.members`);
      assert.ok(!rows.some((row) => row.id === members.choirSinger));
    });

    await db.sql(
      `update public.ministry_members set left_on = null
       where ministry_id = $1 and member_id = $2`,
      [choirId, members.choirSinger],
    );
  });

  it('lets a leader manage their own ministry but not another', async () => {
    const otherMinistry = await db.value(
      `insert into public.ministries (branch_id, name) values ($1, 'Media') returning id`,
      [mainBranch],
    );

    await db.asUser(users.leader, async () => {
      await db.sql(
        `insert into public.ministry_members (ministry_id, member_id, branch_id)
         values ($1, $2, $3)`,
        [choirId, members.stranger, mainBranch],
      );

      const error = await db.expectRejection(
        `insert into public.ministry_members (ministry_id, member_id, branch_id)
         values ($1, $2, $3)`,
        [otherMinistry, members.stranger, mainBranch],
      );
      assert.match(error.message, /row-level security/i);
    });
  });

  it('holds no branch-wide grant that would let it act outside that ministry', async () => {
    // The regression this guards: granting ministries.members.manage or
    // attendance.record branch-wide to the role would make the negative test
    // above pass for the wrong reason and let the choir leader run the Sunday
    // service register.
    const overBroad = await db.sql(
      `select p.key
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where r.key in ('ministry_leader', 'choir_leader')
         and p.key in (
           'ministries.members.manage', 'attendance.record', 'attendance.session.create',
           'attendance.view', 'events.create', 'events.update', 'members.view'
         )
       order by p.key`,
    );
    assert.deepEqual(
      overBroad,
      [],
      'leader authority must come from leadership scope, not a branch grant',
    );
  });

  it('lets a leader run the register for their own ministry session', async () => {
    await db.asUser(users.leader, async () => {
      const sessionId = await db.value(
        `insert into public.attendance_sessions (branch_id, session_type, title, session_date, ministry_id)
         values ($1, 'ministry', 'Choir Rehearsal', current_date, $2) returning id`,
        [mainBranch, choirId],
      );

      await db.sql(
        `insert into public.attendance_records (session_id, branch_id, member_id)
         values ($1, $2, $3)`,
        [sessionId, mainBranch, members.choirSinger],
      );

      assert.equal(
        await db.visibleCount('public.attendance_records', `session_id = '${sessionId}'`),
        1,
      );
    });
  });

  it('refuses that same leader a Sunday service register', async () => {
    await db.asUser(users.leader, async () => {
      const error = await db.expectRejection(
        `insert into public.attendance_sessions (branch_id, session_type, title, session_date)
         values ($1, 'service', 'Leader Overreach Service', current_date)`,
        [mainBranch],
      );
      assert.match(error.message, /row-level security/i);
    });
  });
});

describe('soft-deleted members', () => {
  let removedId;

  before(async () => {
    removedId = await createMember(db, {
      branchId: mainBranch,
      firstName: 'Gone',
      lastName: 'Away',
    });
    await db.sql(`update public.members set deleted_at = now() where id = $1`, [removedId]);
  });

  it('are hidden from a secretary, who cannot restore them', async () => {
    await db.asUser(users.secretary, async () => {
      assert.equal(await db.visibleCount('public.members', `id = '${removedId}'`), 0);
    });
  });

  it('are visible to a Super Administrator, who can', async () => {
    await db.asUser(users.superAdmin, async () => {
      assert.equal(await db.visibleCount('public.members', `id = '${removedId}'`), 1);
    });
  });
});

describe('permission boundaries between roles', () => {
  it('lets a secretary add a member', async () => {
    await db.asUser(users.secretary, async () => {
      await db.sql(
        `insert into public.members (branch_id, first_name, last_name) values ($1, 'New', 'Convert')`,
        [mainBranch],
      );
    });
  });

  it('refuses an elder, who has oversight but not authorship', async () => {
    await db.asUser(users.elder, async () => {
      const error = await db.expectRejection(
        `insert into public.members (branch_id, first_name, last_name) values ($1, 'Elder', 'Insert')`,
        [mainBranch],
      );
      assert.match(error.message, /row-level security/i);
    });
  });

  it('hides financial records from an elder and shows them to the Finance Officer', async () => {
    const categoryId = await db.value(
      `select id from public.transaction_categories where kind = 'income' limit 1`,
    );
    await db.sql(
      `insert into public.transactions
         (branch_id, kind, category_id, income_type, amount, currency, occurred_on, payment_method)
       values ($1, 'income', $2, 'offering', 500.00, 'GHS', current_date, 'cash')`,
      [mainBranch, categoryId],
    );

    await db.asUser(users.elder, async () => {
      assert.equal(await db.visibleCount('public.transactions'), 0);
    });
    await db.asUser(users.finance, async () => {
      assert.ok((await db.visibleCount('public.transactions')) >= 1);
    });
  });

  it('hides the audit log from an elder and shows it to the Senior Pastor', async () => {
    await db.sql(`select app.log_audit('member.created', 'member', 'x')`);

    await db.asUser(users.elder, async () => {
      assert.equal(await db.visibleCount('public.audit_logs'), 0);
    });
    await db.asUser(users.pastor, async () => {
      assert.ok((await db.visibleCount('public.audit_logs')) >= 1);
    });
  });

  it('keeps the permission catalogue away from everyone but role administrators', async () => {
    await db.asUser(users.secretary, async () => {
      assert.equal(await db.visibleCount('public.permissions'), 0);
      assert.equal(await db.visibleCount('public.role_permissions'), 0);
    });
    await db.asUser(users.superAdmin, async () => {
      assert.ok((await db.visibleCount('public.permissions')) >= 50);
    });
  });

  it('still tells a user their own permissions, without table access', async () => {
    await db.asUser(users.usher, async () => {
      const rows = await db.sql(
        `select permission_key from app.my_permissions() order by permission_key`,
      );
      const keys = rows.map((row) => row.permission_key);
      assert.ok(keys.includes('attendance.record'));
      assert.ok(keys.includes('members.view_directory'));
      assert.ok(!keys.includes('members.view'));
    });
  });
});

describe('settings visibility', () => {
  it('shows public settings to any signed-in user but withholds the rest', async () => {
    await db.asUser(users.congregant, async () => {
      const rows = await db.sql(`select key from public.settings order by key`);
      const keys = rows.map((row) => row.key);
      assert.ok(keys.includes('church.name'), 'the UI needs the church name');
      assert.ok(!keys.includes('finance.approval_required'), 'internal settings stay internal');
    });
  });

  it('shows everything to a Super Administrator', async () => {
    await db.asUser(users.superAdmin, async () => {
      assert.ok((await db.visibleCount('public.settings')) >= 4);
    });
  });
});

describe('privilege escalation guards', () => {
  it('refuses a role grant from someone without users.roles.manage', async () => {
    await db.asUser(users.secretary, async () => {
      const error = await db.expectRejection(
        `insert into public.user_roles (user_id, role_id, branch_id)
         select $1, r.id, $2 from public.roles r where r.key = 'super_admin'`,
        [users.congregant, mainBranch],
      );
      // Two layers can refuse this: the escalation trigger fires before the RLS
      // WITH CHECK is evaluated, so either message is a correct outcome.
      assert.ok(
        /row-level security/i.test(error.message) ||
          /you do not hold in that scope/.test(error.message),
        `unexpected refusal: ${error.message}`,
      );
    });

    assert.equal(
      Number(
        await db.value(`select count(*)::int from public.user_roles where user_id = $1`, [
          users.congregant,
        ]),
      ),
      1,
      'the congregant should still hold exactly their member role',
    );
  });

  it('refuses anyone changing their own grants, Super Administrator included', async () => {
    await db.asUser(users.superAdmin, async () => {
      const error = await db.expectRejection(
        `insert into public.user_roles (user_id, role_id, branch_id)
         select $1, r.id, $2 from public.roles r where r.key = 'secretary'`,
        [users.superAdmin, mainBranch],
      );
      assert.match(error.message, /your own role grants/);
    });
  });

  it('refuses a grant of authority the granter does not hold', async () => {
    // A limited administrator: may manage grants, but holds almost nothing else.
    const limitedRole = await db.value(
      `insert into public.roles (key, name) values ('branch_admin', 'Branch Administrator') returning id`,
    );
    await db.sql(
      `insert into public.role_permissions (role_id, permission_id)
       select $1, p.id from public.permissions p
       where p.key in ('users.roles.manage', 'users.view', 'members.view')`,
      [limitedRole],
    );
    const limitedUser = await createUser(db, { email: 'branchadmin@church.test' });
    await db.sql(
      `insert into public.user_roles (user_id, role_id, branch_id) values ($1, $2, $3)`,
      [limitedUser, limitedRole, mainBranch],
    );

    await db.asUser(limitedUser, async () => {
      // secretary carries members.create, which this user does not hold.
      const error = await db.expectRejection(
        `insert into public.user_roles (user_id, role_id, branch_id)
         select $1, r.id, $2 from public.roles r where r.key = 'secretary'`,
        [users.congregant, mainBranch],
      );
      assert.match(error.message, /you do not hold in that scope/);

      // But a role made only of permissions they do hold is fine.
      const viewerRole = await db.value(`select id from public.roles where key = 'branch_admin'`);
      assert.ok(viewerRole);
    });
  });

  it('refuses a branch-scoped administrator minting a global grant', async () => {
    const limitedUser = await db.value(
      `select id from public.profiles where full_name = 'branchadmin'`,
    );

    await db.asUser(limitedUser, async () => {
      const error = await db.expectRejection(
        `insert into public.user_roles (user_id, role_id, branch_id)
         select $1, r.id, null from public.roles r where r.key = 'branch_admin'`,
        [users.congregant],
      );
      assert.match(error.message, /you do not hold in that scope/);
    });
  });

  it('will not let the last active Super Administrator be removed', async () => {
    const secondAdmin = await createUser(db, {
      email: 'second-admin@church.test',
      roles: ['super_admin'],
    });
    // branch_admin holds users.roles.manage and nothing else of consequence, so
    // it can attempt the revocation without guard 1 (no self-edit) interfering.
    const limitedUser = await db.value(
      `select id from public.profiles where full_name = 'branchadmin'`,
    );

    assert.equal(
      Number(
        await db.value(`select count(*)::int from public.user_roles ur
      join public.roles r on r.id = ur.role_id where r.key = 'super_admin'`),
      ),
      2,
    );

    await db.asUser(limitedUser, async () => {
      // Two admins exist, so removing one is allowed.
      await db.sql(`delete from public.user_roles where user_id = $1`, [secondAdmin]);

      // One remains, and it cannot go: removing it would leave nobody able to
      // administer the system.
      const error = await db.expectRejection(
        `delete from public.user_roles ur where ur.user_id = $1`,
        [users.superAdmin],
      );
      assert.match(error.message, /last active Super Administrator/);
    });

    assert.equal(
      Number(
        await db.value(`select count(*)::int from public.user_roles ur
      join public.roles r on r.id = ur.role_id where r.key = 'super_admin'`),
      ),
      1,
    );
  });

  it('refuses a deactivation by someone without users.deactivate', async () => {
    await db.asUser(users.secretary, async () => {
      // A secretary cannot see or edit other profiles, so this matches no rows
      // rather than raising. The assertion that matters is that nothing changed.
      await db.sql(`update public.profiles set is_active = false where id = $1`, [users.elder]);
    });

    assert.equal(
      await db.value(`select is_active from public.profiles where id = $1`, [users.elder]),
      true,
    );
  });

  it('refuses a deactivated user reactivating themselves', async () => {
    await db.asUser(users.suspended, async () => {
      const error = await db.expectRejection(
        `update public.profiles set is_active = true where id = $1`,
        [users.suspended],
      );
      assert.match(error.message, /users.deactivate/);
    });
  });
});

describe('attendance sessions', () => {
  it('lets an usher open a session and record attendance', async () => {
    await db.asUser(users.usher, async () => {
      const sessionId = await db.value(
        `insert into public.attendance_sessions (branch_id, session_type, title, session_date, count_adults)
         values ($1, 'service', 'Sunday First Service', current_date, 180) returning id`,
        [mainBranch],
      );
      await db.sql(
        `insert into public.attendance_records (session_id, branch_id, member_id, method)
         values ($1, $2, $3, 'search')`,
        [sessionId, mainBranch, members.congregant],
      );
      assert.ok(sessionId);
    });
  });

  it('freezes the register once the session is closed', async () => {
    const sessionId = await db.value(
      `insert into public.attendance_sessions (branch_id, session_type, title, session_date)
       values ($1, 'service', 'Closed Service', current_date - 3) returning id`,
      [mainBranch],
    );
    await db.sql(
      `update public.attendance_sessions set status = 'closed', closed_at = now() where id = $1`,
      [sessionId],
    );

    await db.asUser(users.usher, async () => {
      const error = await db.expectRejection(
        `insert into public.attendance_records (session_id, branch_id, member_id) values ($1, $2, $3)`,
        [sessionId, mainBranch, members.stranger],
      );
      assert.match(error.message, /session is closed/);
    });
  });

  it('refuses an usher reopening a closed session', async () => {
    const sessionId = await db.value(
      `select id from public.attendance_sessions where title = 'Closed Service'`,
    );
    await db.asUser(users.usher, async () => {
      const error = await db.expectRejection(
        `update public.attendance_sessions set status = 'open' where id = $1`,
        [sessionId],
      );
      assert.match(error.message, /attendance.session.close/);
    });
  });

  it('lets a member see their own attendance history and no one else’s', async () => {
    await db.asUser(users.congregant, async () => {
      const rows = await db.sql(`select member_id from public.attendance_records`);
      assert.ok(rows.length >= 1);
      assert.ok(rows.every((row) => row.member_id === members.congregant));
    });
  });
});
