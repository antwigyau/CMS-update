import { createTestDatabase } from '../tests/db/harness.js';

const db = await createTestDatabase();
const q = async (label, sql) => process.stdout.write(`${label}: ${await db.value(sql)}\n`);

process.stdout.write(`migrations: ${db.migrations.length}\n`);
await q(
  'tables',
  "select count(*)::int from information_schema.tables where table_schema='public' and table_type='BASE TABLE'",
);
await q('permissions', 'select count(*)::int from public.permissions');
await q('roles', 'select count(*)::int from public.roles');
await q('role_grants', 'select count(*)::int from public.role_permissions');
await q('policies_public', "select count(*)::int from pg_policies where schemaname='public'");
await q('policies_storage', "select count(*)::int from pg_policies where schemaname='storage'");
await q(
  'app_functions',
  "select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app'",
);
await q('indexes', "select count(*)::int from pg_indexes where schemaname='public'");
await q(
  'check_constraints',
  "select count(*)::int from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' and c.contype='c'",
);
await q(
  'triggers',
  "select count(*)::int from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal",
);

await db.close();
