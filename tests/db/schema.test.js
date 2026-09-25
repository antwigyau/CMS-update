/**
 * Structural assertions over the applied schema.
 *
 * The first thing this file proves is simply that all fourteen migrations and
 * the seed execute. After that it checks the invariants that are easy to break
 * silently later: RLS enabled everywhere, no delete path on the append-only
 * tables, and every SECURITY DEFINER function pinned to an empty search_path.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestDatabase, listMigrations } from './harness.js';

let db;

before(async () => {
  db = await createTestDatabase();
});

after(async () => {
  await db?.close();
});

describe('migrations', () => {
  it('all apply in order, on an empty database', async () => {
    const migrations = await listMigrations();
    assert.ok(
      migrations.length >= 13,
      `expected the full migration set, found ${migrations.length}`,
    );
    assert.deepEqual(migrations, [...migrations].sort(), 'filenames must sort into apply order');
  });

  it('creates every expected table', async () => {
    const rows = await db.sql(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name`,
    );
    const tables = rows.map((row) => row.table_name);

    const expected = [
      'attendance_records',
      'attendance_sessions',
      'audit_logs',
      'branches',
      'event_categories',
      'event_registrations',
      'events',
      'families',
      'family_members',
      'member_emergency_contacts',
      'member_spiritual_gifts',
      'members',
      'ministries',
      'ministry_members',
      'notification_recipients',
      'notifications',
      'permissions',
      'profiles',
      'role_permissions',
      'roles',
      'settings',
      'spiritual_gifts',
      'transaction_categories',
      'transactions',
      'user_roles',
    ];

    assert.deepEqual(tables, expected);
  });
});

describe('row level security', () => {
  it('is enabled on every table in public — no exceptions', async () => {
    const rows = await db.sql(
      `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
       order by c.relname`,
    );
    assert.deepEqual(
      rows.map((row) => row.relname),
      [],
      'these tables have RLS disabled, which means anon and authenticated can read them',
    );
  });

  it('gives every table at least one policy, so none is accidentally unreachable', async () => {
    const rows = await db.sql(
      `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
       order by c.relname`,
    );
    assert.deepEqual(
      rows.map((row) => row.relname),
      [],
    );
  });
});

describe('append-only and no-delete tables', () => {
  const policyKinds = async (table) => {
    const rows = await db.sql(
      `select cmd from pg_policies where schemaname = 'public' and tablename = $1`,
      [table],
    );
    return new Set(rows.map((row) => row.cmd));
  };

  it('audit_logs has no update or delete policy', async () => {
    const kinds = await policyKinds('audit_logs');
    assert.ok(!kinds.has('UPDATE'), 'audit rows must not be editable');
    assert.ok(!kinds.has('DELETE'), 'audit rows must not be deletable');
    assert.ok(!kinds.has('INSERT'), 'audit rows are written by app.log_audit only');
    assert.ok(kinds.has('SELECT'));
  });

  it('audit_logs also blocks update and delete with triggers, for every role', async () => {
    const rows = await db.sql(
      `select tgname from pg_trigger
       where tgrelid = 'public.audit_logs'::regclass and not tgisinternal
       order by tgname`,
    );
    assert.deepEqual(
      rows.map((row) => row.tgname),
      ['audit_logs_deny_delete', 'audit_logs_deny_update'],
    );
  });

  it('transactions has no delete policy — reversal is void (D3)', async () => {
    const kinds = await policyKinds('transactions');
    assert.ok(!kinds.has('DELETE'));
    assert.ok(!kinds.has('ALL'), 'a FOR ALL policy would silently include DELETE');
  });

  it('members has no delete policy — removal is a soft delete', async () => {
    const kinds = await policyKinds('members');
    assert.ok(!kinds.has('DELETE'));
    assert.ok(!kinds.has('ALL'));
  });

  it('profiles cannot be inserted or deleted through the API', async () => {
    const kinds = await policyKinds('profiles');
    assert.ok(!kinds.has('INSERT'));
    assert.ok(!kinds.has('DELETE'));
  });
});

describe('SECURITY DEFINER functions', () => {
  it('all pin search_path, so none can be hijacked by object shadowing', async () => {
    const rows = await db.sql(
      `select n.nspname || '.' || p.proname as name
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('app', 'public')
         and p.prosecdef
         and (
           p.proconfig is null
           or not exists (
             select 1 from unnest(p.proconfig) as cfg where cfg like 'search_path=%'
           )
         )
       order by name`,
    );
    assert.deepEqual(
      rows.map((row) => row.name),
      [],
      'a SECURITY DEFINER function without a pinned search_path is a privilege-escalation route',
    );
  });

  it('exposes the authorization helpers the policies depend on', async () => {
    const rows = await db.sql(
      `select p.proname from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' order by p.proname`,
    );
    const names = rows.map((row) => row.proname);

    for (const required of [
      'can_edit_member',
      'can_view_member',
      'current_member_id',
      'has_permission',
      'has_permission_in',
      'is_ministry_leader',
      'leads_ministry_of_member',
      'log_audit',
      'my_permissions',
    ]) {
      assert.ok(names.includes(required), `app.${required} is missing`);
    }
  });
});

describe('seed data', () => {
  it('creates the eleven roles from the specification, all marked as system roles', async () => {
    const rows = await db.sql(`select key, is_system from public.roles order by sort_order`);
    assert.deepEqual(
      rows.map((row) => row.key),
      [
        'super_admin',
        'senior_pastor',
        'finance_officer',
        'church_elder',
        'secretary',
        'ministry_leader',
        'choir_leader',
        'media_team',
        'usher',
        'member',
        'guest',
      ],
    );
    assert.ok(rows.every((row) => row.is_system));
  });

  it('derives permission resource and action from the key, consistently', async () => {
    const mismatched = await db.sql(
      `select key from public.permissions where key <> resource || '.' || action`,
    );
    assert.deepEqual(mismatched, []);

    const count = Number(await db.value(`select count(*)::int from public.permissions`));
    assert.ok(count >= 50, `expected the full permission catalogue, found ${count}`);
  });

  it('grants super_admin every permission, including ones added later', async () => {
    const missing = await db.sql(
      `select p.key
       from public.permissions p
       where not exists (
         select 1 from public.role_permissions rp
         join public.roles r on r.id = rp.role_id
         where rp.permission_id = p.id and r.key = 'super_admin'
       )`,
    );
    assert.deepEqual(missing, []);
  });

  it('withholds finance approval from the Finance Officer (decision D6)', async () => {
    const held = await db.sql(
      `select p.key
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where r.key = 'finance_officer'
         and p.key in ('finance.approve', 'finance.reject', 'finance.void')`,
    );
    assert.deepEqual(held, [], 'the Finance Officer records and submits, but must not approve');

    const canSubmit = await db.value(
      `select count(*)::int from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where r.key = 'finance_officer' and p.key = 'finance.submit'`,
    );
    assert.equal(Number(canSubmit), 1);
  });

  it('gives the Senior Pastor approval but not the ability to record', async () => {
    const keys = await db.sql(
      `select p.key
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where r.key = 'senior_pastor' and p.key like 'finance.%'
       order by p.key`,
    );
    assert.deepEqual(
      keys.map((row) => row.key),
      ['finance.approve', 'finance.reject', 'finance.view', 'finance.void'],
    );
  });

  it('gives an usher the directory but never full member records', async () => {
    const keys = await db.sql(
      `select p.key
       from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       join public.permissions p on p.id = rp.permission_id
       where r.key = 'usher' and p.key like 'members.%'
       order by p.key`,
    );
    assert.deepEqual(
      keys.map((row) => row.key),
      ['members.view_directory'],
    );
  });

  it('gives the guest role no permissions at all', async () => {
    const count = await db.value(
      `select count(*)::int from public.role_permissions rp
       join public.roles r on r.id = rp.role_id
       where r.key = 'guest'`,
    );
    assert.equal(Number(count), 0);
  });

  it('seeds exactly one branch, and reference lists that administrators can edit', async () => {
    assert.equal(Number(await db.value(`select count(*)::int from public.branches`)), 1);
    assert.ok(Number(await db.value(`select count(*)::int from public.spiritual_gifts`)) >= 20);
    assert.ok(Number(await db.value(`select count(*)::int from public.event_categories`)) >= 10);
    assert.ok(
      Number(await db.value(`select count(*)::int from public.transaction_categories`)) >= 15,
    );
  });

  it('seeds finance.currency to the configured currency (GHS), not a guess', async () => {
    // Until Q4c was answered this was seeded NULL on purpose, so the module would
    // refuse to transact rather than guess. The owner has since chosen GHS, so the
    // seed carries it and the service reads it from here rather than defaulting.
    const row = await db.one(
      `select value, description from public.settings where key = 'finance.currency'`,
    );
    assert.ok(row, 'the setting row should exist');
    assert.equal(row.value, 'GHS', 'the configured currency, stamped onto every transaction');
    assert.match(row.description, /GHS/);
  });

  it('is idempotent — running it twice changes nothing', async () => {
    const before = await db.one(
      `select
         (select count(*) from public.roles) as roles,
         (select count(*) from public.permissions) as permissions,
         (select count(*) from public.role_permissions) as grants,
         (select count(*) from public.branches) as branches,
         (select count(*) from public.transaction_categories) as categories`,
    );

    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    await db.exec(
      await readFile(fileURLToPath(new URL('../../supabase/seed.sql', import.meta.url)), 'utf8'),
    );

    const after = await db.one(
      `select
         (select count(*) from public.roles) as roles,
         (select count(*) from public.permissions) as permissions,
         (select count(*) from public.role_permissions) as grants,
         (select count(*) from public.branches) as branches,
         (select count(*) from public.transaction_categories) as categories`,
    );

    assert.deepEqual(after, before);
  });
});
