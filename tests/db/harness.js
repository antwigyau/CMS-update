/**
 * Database test harness.
 *
 * Spins up PGlite — PostgreSQL compiled to WebAssembly, running in this process
 * — applies the Supabase shims, then every migration in `supabase/migrations`
 * in filename order, then `supabase/seed.sql`.
 *
 * The point is that the schema is EXECUTED. A migration that does not parse, a
 * constraint that contradicts itself, or an RLS policy that recurses will fail
 * here rather than on first contact with a real database.
 *
 * What it does not cover is listed at the top of shims.sql. Verification against
 * a real Supabase instance is still required, and is what `supabase start` is
 * for once Docker is available.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const SHIMS = join(ROOT, 'tests', 'db', 'shims.sql');
const SEED = join(ROOT, 'supabase', 'seed.sql');

export async function listMigrations() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

/**
 * @returns {Promise<TestDatabase>}
 */
export async function createTestDatabase({ seed = true } = {}) {
  const pg = await PGlite.create();

  const apply = async (label, sql) => {
    try {
      await pg.exec(sql);
    } catch (error) {
      // Without the filename, a syntax error in one of fourteen files is a
      // guessing game.
      error.message = `while applying ${label}: ${error.message}`;
      throw error;
    }
  };

  await apply('shims.sql', await readFile(SHIMS, 'utf8'));

  const migrations = await listMigrations();
  for (const name of migrations) {
    await apply(name, await readFile(join(MIGRATIONS_DIR, name), 'utf8'));
  }

  if (seed) {
    await apply('seed.sql', await readFile(SEED, 'utf8'));
  }

  return new TestDatabase(pg, migrations);
}

class TestDatabase {
  constructor(pg, migrations) {
    this.pg = pg;
    this.migrations = migrations;
  }

  /** Run as the owner (bypasses RLS). Use for setup and for asserting state. */
  async sql(query, params = []) {
    const result = await this.pg.query(query, params);
    return result.rows;
  }

  async exec(sql) {
    return this.pg.exec(sql);
  }

  async one(query, params = []) {
    const rows = await this.sql(query, params);
    return rows[0] ?? null;
  }

  async value(query, params = []) {
    const row = await this.one(query, params);
    if (!row) return null;
    return Object.values(row)[0];
  }

  /**
   * Run `fn` as `authenticated` with `sub` set to userId — the same shape
   * PostgREST produces for a signed-in request. Session state is always reset,
   * including when the body throws, so one failing test cannot leak an identity
   * into the next.
   */
  async asUser(userId, fn) {
    await this.pg.exec(
      `set request.jwt.claims = '${JSON.stringify({ sub: userId, role: 'authenticated' })}'; set role authenticated;`,
    );
    try {
      return await fn(this);
    } finally {
      await this.pg.exec(`reset role; reset request.jwt.claims;`);
    }
  }

  /** Run `fn` as `anon`: no session at all. */
  async asAnon(fn) {
    await this.pg.exec(`set request.jwt.claims = '{}'; set role anon;`);
    try {
      return await fn(this);
    } finally {
      await this.pg.exec(`reset role; reset request.jwt.claims;`);
    }
  }

  /**
   * Assert that a statement is refused. Returns the error so the caller can
   * check the message, and fails loudly if the statement unexpectedly succeeded
   * — a silently permitted write is the failure mode that matters here.
   */
  async expectRejection(query, params = []) {
    try {
      await this.sql(query, params);
    } catch (error) {
      return error;
    }
    throw new Error(`Expected this statement to be rejected, but it succeeded:\n${query}`);
  }

  /** Rows visible to the current role, for RLS assertions. */
  async visibleCount(table, where = 'true') {
    return Number(await this.value(`select count(*)::int from ${table} where ${where}`));
  }

  async close() {
    await this.pg.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Fixture helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Create an auth user, its profile, and optionally grant roles.
 * Runs as the owner, standing in for the service-role provisioning path.
 *
 * @param {TestDatabase} db
 * @param {object} options
 * @param {string} options.email
 * @param {string} [options.fullName]
 * @param {string[]} [options.roles]     role keys
 * @param {string|null} [options.branchId]  null grants the roles in every branch
 * @param {boolean} [options.isActive]
 */
export async function createUser(
  db,
  { email, fullName, roles = [], branchId = null, isActive = true },
) {
  const userId = await db.value(`insert into auth.users (email) values ($1) returning id`, [email]);

  await db.sql(`insert into public.profiles (id, full_name, is_active) values ($1, $2, $3)`, [
    userId,
    fullName ?? email.split('@')[0],
    isActive,
  ]);

  for (const roleKey of roles) {
    await db.sql(
      `insert into public.user_roles (user_id, role_id, branch_id)
       select $1, r.id, $2 from public.roles r where r.key = $3`,
      [userId, branchId, roleKey],
    );
  }

  return userId;
}

/** The seeded default branch. */
export async function defaultBranchId(db) {
  return db.value(`select id from public.branches where code = 'MAIN'`);
}

/**
 * Create a member. `userId` links the member to a login, which is what makes the
 * "own record" policies apply.
 */
export async function createMember(db, { branchId, firstName, lastName, userId = null, ...rest }) {
  const columns = ['branch_id', 'first_name', 'last_name', 'user_id'];
  const values = [branchId, firstName, lastName, userId];

  for (const [key, value] of Object.entries(rest)) {
    columns.push(key);
    values.push(value);
  }

  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
  return db.value(
    `insert into public.members (${columns.join(', ')}) values (${placeholders}) returning id`,
    values,
  );
}
