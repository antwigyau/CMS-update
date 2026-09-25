/**
 * User administration (Phase 13): profiles, activation, and role grants.
 *
 * The guards in the routes are a mirror; the real authority is the database — RLS
 * on `profiles`/`roles`/`user_roles` plus the escalation triggers. So these tests
 * prove three things the API is responsible for on its own:
 *
 *   - the permission matrix: `users.view` reads, `users.invite` provisions,
 *     `users.update` edits, `users.deactivate` toggles activation, and
 *     `users.roles.manage` grants and revokes — each genuinely separate;
 *   - the self-service refusals, returned early as a legible 403 rather than left
 *     to the trigger's generic `insufficient_privilege`;
 *   - the one privileged path — invite — creates the auth user and the profile
 *     together, and rolls the auth user back if the profile insert fails.
 *
 * 'user-17' holds the full account-management set (all global); 'user-18' holds
 * only `users.view`; 'user-2' holds none. `granted_by` is always stamped from the
 * caller, never taken from the client.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createUsersService, escapeLikePattern } from '../../src/services/users.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import {
  roleGrantSchema,
  toUserRow,
  userActiveSchema,
  userInviteSchema,
  userUpdateSchema,
} from '../../src/validation/users.schemas.js';
import {
  BRANCH_MAIN,
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });

/** A target account, distinct from any caller so self-service checks are exercised. */
const TARGET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ROLE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const GRANT_ID = '9f8c7b6a-5d4e-4c3b-8a29-1f0e2d3c4b5a';

function userRow(overrides = {}) {
  return {
    id: TARGET,
    full_name: 'Kwabena Member',
    phone: null,
    avatar_path: null,
    default_branch_id: BRANCH_MAIN,
    is_active: true,
    last_login_at: null,
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-01T10:00:00.000Z',
    user_roles: [],
    ...overrides,
  };
}

const roleRow = (o = {}) => ({
  id: ROLE_ID,
  key: 'secretary',
  name: 'Secretary',
  description: null,
  is_system: false,
  sort_order: 30,
  ...o,
});

const grantRow = (o = {}) => ({
  id: GRANT_ID,
  role_id: ROLE_ID,
  branch_id: BRANCH_MAIN,
  granted_at: '2026-09-01T10:00:00.000Z',
  roles: { key: 'secretary', name: 'Secretary' },
  ...o,
});

/**
 * A fake service-role client for the invite path only: a GoTrue admin surface
 * bolted onto the query recorder, so the profile insert is recorded like any
 * other query while `inviteUserByEmail` / `deleteUser` are observable.
 */
function fakeAdmin({
  inviteError = null,
  inviteUserId = TARGET,
  insertRow = userRow({ id: TARGET }),
  insertError = null,
} = {}) {
  const calls = { invited: [], deleted: [] };
  const recorder = createQueryRecorder({
    rows: insertError ? [] : [insertRow],
    error: insertError,
  });
  const client = {
    ...recorder.client,
    auth: {
      admin: {
        async inviteUserByEmail(email, options) {
          calls.invited.push({ email, options });
          if (inviteError) return { data: null, error: inviteError };
          return { data: { user: { id: inviteUserId } }, error: null };
        },
        async deleteUser(id) {
          calls.deleted.push(id);
          return { data: {}, error: null };
        },
      },
    },
  };
  return { getAdminClient: () => client, recorder, calls };
}

/** 'user-17' is the full user administrator; see the module comment. */
function createClient({ as = 'user-17', admin, ...recorderOptions } = {}) {
  const recorder = createQueryRecorder(recorderOptions);
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });
  const adminFake = admin ?? fakeAdmin();

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    users: createUsersService({
      getClient: recorder.getClient,
      getAdminClient: adminFake.getAdminClient,
    }),
  });

  const token = mintToken({ sub: as });
  const csrf = 'a'.repeat(64);

  async function call(path, { method = 'GET', body } = {}) {
    const headers = {
      'sec-fetch-site': 'same-origin',
      cookie: `cma_at=${token}; cma_csrf=${csrf}`,
      'x-csrf-token': csrf,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return handleRequest(
      new Request(`http://localhost:3000${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { router, sink: () => {} },
    );
  }

  return { call, recorder, admin: adminFake };
}

/* ---- route table --------------------------------------------------------- */

describe('the user-admin route table', () => {
  const routes = buildRouter({
    cfg,
    provider: createFakeProvider({}).provider,
    loadIdentity: createFakeIdentityLoader({}),
    users: createUsersService({
      getClient: createQueryRecorder().getClient,
      getAdminClient: fakeAdmin().getAdminClient,
    }),
  })
    .list()
    .filter((route) => route.pattern.startsWith('/admin/users'));

  it('registers the eight endpoints, none public and none a plain DELETE user', () => {
    assert.equal(routes.length, 8);
    for (const route of routes) assert.equal(route.isPublic, false);
    assert.equal(
      routes.some((r) => r.method === 'DELETE' && r.pattern === '/admin/users/:id'),
      false,
      'an account with history is deactivated, never deleted',
    );
  });

  it('gates each operation on its own permission', () => {
    const find = (method, pattern) =>
      routes.find((r) => r.method === method && r.pattern === pattern)?.permission;

    assert.equal(find('GET', '/admin/users'), 'users.view');
    assert.equal(find('POST', '/admin/users'), 'users.invite');
    assert.equal(find('GET', '/admin/users/roles'), 'users.view');
    assert.equal(find('GET', '/admin/users/:id'), 'users.view');
    assert.equal(find('PATCH', '/admin/users/:id'), 'users.update');
    assert.equal(find('POST', '/admin/users/:id/active'), 'users.deactivate');
    assert.equal(find('POST', '/admin/users/:id/roles'), 'users.roles.manage');
    assert.equal(find('DELETE', '/admin/users/:id/roles/:grantId'), 'users.roles.manage');
  });

  it('routes the literal /admin/users/roles before the /admin/users/:id parameter', () => {
    const patterns = routes.map((r) => r.pattern);
    assert.ok(patterns.indexOf('/admin/users/roles') < patterns.indexOf('/admin/users/:id'));
  });
});

/* ---- validation ---------------------------------------------------------- */

describe('user-admin validation', () => {
  it('invites on an email and a name, lowercasing the email', () => {
    const parsed = userInviteSchema.safeParse({ email: 'New.Person@Church.TEST', fullName: 'Ny' });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data.email, 'new.person@church.test');
  });

  it('refuses an invite missing a name, a bad email, or an unknown field', () => {
    assert.equal(userInviteSchema.safeParse({ email: 'a@b.com' }).success, false);
    assert.equal(userInviteSchema.safeParse({ email: 'nope', fullName: 'Ny' }).success, false);
    assert.equal(
      userInviteSchema.safeParse({ email: 'a@b.com', fullName: 'Ny', password: 'x' }).success,
      false,
      'a client cannot choose an initial password',
    );
  });

  it('will not let isActive or id ride in on a profile edit', () => {
    assert.equal(userUpdateSchema.safeParse({ isActive: false }).success, false);
    assert.equal(userUpdateSchema.safeParse({ id: TARGET, fullName: 'Ny' }).success, false);
  });

  it('rejects an empty edit rather than making it a silent no-op', () => {
    assert.equal(userUpdateSchema.safeParse({}).success, false);
    assert.equal(userUpdateSchema.safeParse({ fullName: 'Ny' }).success, true);
  });

  it('makes activation a single required boolean', () => {
    assert.equal(userActiveSchema.safeParse({ isActive: true }).success, true);
    assert.equal(userActiveSchema.safeParse({ isActive: 'yes' }).success, false);
    assert.equal(userActiveSchema.safeParse({}).success, false);
  });

  it('grants on a uuid role, with a branch that may be null (every branch)', () => {
    assert.equal(roleGrantSchema.safeParse({ roleId: ROLE_ID }).success, true);
    assert.equal(roleGrantSchema.safeParse({ roleId: ROLE_ID, branchId: null }).success, true);
    assert.equal(roleGrantSchema.safeParse({ roleId: 'not-a-uuid' }).success, false);
  });

  it('drops undefined columns from a profile patch, never writing id or activation', () => {
    assert.deepEqual(toUserRow({ fullName: 'Ny', defaultBranchId: null }), {
      full_name: 'Ny',
      default_branch_id: null,
    });
  });
});

/* ---- service ------------------------------------------------------------- */

describe('escapeLikePattern', () => {
  it('neutralises the LIKE wildcards and the escape character itself', () => {
    assert.equal(escapeLikePattern('50% a_b'), '50\\% a\\_b');
    assert.equal(escapeLikePattern('a\\b'), 'a\\\\b');
  });
});

describe('the users service', () => {
  it('filters, sorts, and pages the list, returning the exact count', async () => {
    const recorder = createQueryRecorder({ rows: [userRow()], count: 7 });
    const users = createUsersService({ getClient: recorder.getClient });

    const result = await users.list({
      accessToken: 't',
      search: 'a%b',
      isActive: true,
      branchId: BRANCH_MAIN,
      sort: { column: 'full_name', ascending: true },
      pagination: { from: 0, to: 24, page: 1, pageSize: 25 },
    });

    assert.deepEqual(result, { rows: [userRow()], total: 7 });
    assert.deepEqual(recorder.argsFor('ilike'), ['full_name', '%a\\%b%']);
    const eqs = recorder.allArgsFor('eq');
    assert.ok(eqs.some(([c, v]) => c === 'is_active' && v === true));
    assert.ok(eqs.some(([c, v]) => c === 'default_branch_id' && v === BRANCH_MAIN));
    // A stable secondary sort by id keeps pages from overlapping on ties.
    assert.deepEqual(recorder.allArgsFor('order'), [
      ['full_name', { ascending: true }],
      ['id', { ascending: true }],
    ]);
    assert.deepEqual(recorder.argsFor('range'), [0, 24]);
  });

  it('does not filter when no narrowing is asked for', async () => {
    const recorder = createQueryRecorder({ rows: [], count: 0 });
    const users = createUsersService({ getClient: recorder.getClient });

    await users.list({
      accessToken: 't',
      sort: { column: 'full_name', ascending: true },
      pagination: { from: 0, to: 24 },
    });
    assert.equal(recorder.called('ilike'), false);
    assert.equal(recorder.called('eq'), false);
  });

  it('reads one profile, and 404s when the id is unknown or hidden by RLS', async () => {
    const present = createUsersService({
      getClient: createQueryRecorder({ rows: [userRow()] }).getClient,
    });
    assert.equal((await present.get({ accessToken: 't', id: TARGET })).id, TARGET);

    const absent = createUsersService({ getClient: createQueryRecorder({ rows: [] }).getClient });
    await assert.rejects(absent.get({ accessToken: 't', id: TARGET }), /does not exist/);
  });

  it('edits by id and 404s on a patch to a missing profile', async () => {
    const recorder = createQueryRecorder({ rows: [userRow({ full_name: 'Renamed' })] });
    const users = createUsersService({ getClient: recorder.getClient });

    const row = await users.update({
      accessToken: 't',
      id: TARGET,
      patch: { full_name: 'Renamed' },
    });
    assert.equal(row.full_name, 'Renamed');
    assert.deepEqual(recorder.argsFor('update'), [{ full_name: 'Renamed' }]);

    const missing = createUsersService({ getClient: createQueryRecorder({ rows: [] }).getClient });
    await assert.rejects(
      missing.update({ accessToken: 't', id: TARGET, patch: {} }),
      /does not exist/,
    );
  });

  it('toggles activation by writing only is_active', async () => {
    const recorder = createQueryRecorder({ rows: [userRow({ is_active: false })] });
    const users = createUsersService({ getClient: recorder.getClient });

    await users.setActive({ accessToken: 't', id: TARGET, isActive: false });
    assert.deepEqual(recorder.argsFor('update'), [{ is_active: false }]);
  });

  it('reads the role catalogue ordered by sort_order then key', async () => {
    const recorder = createQueryRecorder({ rows: [roleRow()] });
    const users = createUsersService({ getClient: recorder.getClient });

    await users.listRoles({ accessToken: 't' });
    assert.deepEqual(recorder.allArgsFor('order'), [
      ['sort_order', { ascending: true }],
      ['key', { ascending: true }],
    ]);
  });

  it('stamps granted_by from the caller when granting a role', async () => {
    const recorder = createQueryRecorder({ rows: [grantRow()] });
    const users = createUsersService({ getClient: recorder.getClient });

    await users.grantRole({
      accessToken: 't',
      userId: TARGET,
      roleId: ROLE_ID,
      branchId: BRANCH_MAIN,
      grantedBy: 'user-17',
    });
    assert.deepEqual(recorder.argsFor('insert'), [
      { user_id: TARGET, role_id: ROLE_ID, branch_id: BRANCH_MAIN, granted_by: 'user-17' },
    ]);
  });

  it('revokes a grant scoped by both its id and its owner, 404ing otherwise', async () => {
    const recorder = createQueryRecorder({ rows: [{ id: GRANT_ID }] });
    const users = createUsersService({ getClient: recorder.getClient });

    await users.revokeRole({ accessToken: 't', userId: TARGET, grantId: GRANT_ID });
    const eqs = recorder.allArgsFor('eq');
    assert.ok(eqs.some(([c, v]) => c === 'id' && v === GRANT_ID));
    assert.ok(eqs.some(([c, v]) => c === 'user_id' && v === TARGET));

    const missing = createUsersService({ getClient: createQueryRecorder({ rows: [] }).getClient });
    await assert.rejects(
      missing.revokeRole({ accessToken: 't', userId: TARGET, grantId: GRANT_ID }),
      /does not exist/,
    );
  });
});

/* ---- the invite handshake (service-role) --------------------------------- */

describe('the invite handshake', () => {
  it('creates the auth user, then inserts the profile with the returned id', async () => {
    const admin = fakeAdmin();
    const users = createUsersService({ getAdminClient: admin.getAdminClient });

    const created = await users.invite({
      email: 'new@church.test',
      fullName: 'New Person',
      defaultBranchId: BRANCH_MAIN,
      redirectTo: 'http://localhost:3000/reset-password',
    });

    assert.equal(created.id, TARGET);
    assert.equal(admin.calls.invited[0].email, 'new@church.test');
    assert.equal(admin.calls.invited[0].options.data.full_name, 'New Person');
    assert.match(admin.calls.invited[0].options.redirectTo, /\/reset-password$/);
    assert.deepEqual(admin.recorder.argsFor('insert'), [
      { id: TARGET, full_name: 'New Person', default_branch_id: BRANCH_MAIN },
    ]);
    assert.equal(admin.calls.deleted.length, 0);
  });

  it('maps an already-registered email to a 409 and never touches profiles', async () => {
    const admin = fakeAdmin({
      inviteError: { code: 'email_exists', status: 422, message: 'User already registered' },
    });
    const users = createUsersService({ getAdminClient: admin.getAdminClient });

    await assert.rejects(
      users.invite({ email: 'dup@church.test', fullName: 'Dup', redirectTo: 'x' }),
      (error) => error.status === 409,
    );
    assert.equal(admin.recorder.called('insert'), false);
    assert.equal(admin.calls.deleted.length, 0);
  });

  it('rolls back the orphaned auth user when the profile insert fails', async () => {
    const admin = fakeAdmin({
      insertError: { code: '23505', message: 'duplicate key value violates profiles_pkey' },
    });
    const users = createUsersService({ getAdminClient: admin.getAdminClient });

    await assert.rejects(
      users.invite({ email: 'x@church.test', fullName: 'Halfmade', redirectTo: 'x' }),
    );
    assert.deepEqual(admin.calls.deleted, [TARGET]);
  });
});

/* ---- endpoints ----------------------------------------------------------- */

describe('the user-admin endpoints', () => {
  it('lists profiles for an administrator, passing the search and filters through', async () => {
    const { call, recorder } = createClient({ rows: [userRow()], count: 3 });
    const response = await call(
      `/api/admin/users?search=ama&active=true&branchId=${BRANCH_MAIN}&sort=name`,
    );
    assert.equal(response.status, 200);

    const { data, meta } = await response.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].id, TARGET);
    assert.equal(meta.total, 3);
    assert.deepEqual(recorder.argsFor('ilike'), ['full_name', '%ama%']);
    const eqs = recorder.allArgsFor('eq');
    assert.ok(eqs.some(([c, v]) => c === 'is_active' && v === true));
    assert.ok(eqs.some(([c, v]) => c === 'default_branch_id' && v === BRANCH_MAIN));
  });

  it('reads a non-self target, whom the caller may deactivate and re-role', async () => {
    const { call } = createClient({ rows: [userRow()] });
    const response = await call(`/api/admin/users/${TARGET}`);
    assert.equal(response.status, 200);

    const { data } = await response.json();
    assert.equal(data.id, TARGET);
    assert.deepEqual(
      {
        canUpdate: data.canUpdate,
        canDeactivate: data.canDeactivate,
        canManageRoles: data.canManageRoles,
      },
      { canUpdate: true, canDeactivate: true, canManageRoles: true },
    );
  });

  it('never offers a user the controls to change their own account', async () => {
    const { call } = createClient({ rows: [userRow({ id: 'user-17' })] });
    const { data } = await (await call('/api/admin/users/user-17')).json();

    // Editing your own profile is fine; deactivating or re-roling yourself is not,
    // so those two flags are false even though the caller holds the permissions.
    assert.equal(data.canUpdate, true);
    assert.equal(data.canDeactivate, false);
    assert.equal(data.canManageRoles, false);
  });

  it('reflects the caller’s own permissions in the capability flags', async () => {
    const { call } = createClient({ as: 'user-18', rows: [userRow()] });
    const { data } = await (await call(`/api/admin/users/${TARGET}`)).json();

    // A users.view holder sees the profile but is offered no write controls.
    assert.equal(data.canUpdate, false);
    assert.equal(data.canDeactivate, false);
    assert.equal(data.canManageRoles, false);
  });

  it('serves the role catalogue on the literal path, not the :id route', async () => {
    const { call } = createClient({ rows: [roleRow()] });
    const response = await call('/api/admin/users/roles');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].key, 'secretary');
  });

  it('invites a new account: 201, the created profile, and a Location header', async () => {
    const { call } = createClient();
    const response = await call('/api/admin/users', {
      method: 'POST',
      body: {
        email: 'New.Person@Church.TEST',
        fullName: 'New Person',
        defaultBranchId: BRANCH_MAIN,
      },
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location'), `/api/admin/users/${TARGET}`);
    assert.equal((await response.json()).data.id, TARGET);
  });

  it('maps an already-registered email to a 409', async () => {
    const admin = fakeAdmin({
      inviteError: { code: 'email_exists', status: 422, message: 'User already registered' },
    });
    const { call } = createClient({ admin });
    const response = await call('/api/admin/users', {
      method: 'POST',
      body: { email: 'dup@church.test', fullName: 'Dup' },
    });
    assert.equal(response.status, 409);
    assert.equal(admin.recorder.called('insert'), false);
  });

  it('edits a profile', async () => {
    const { call, recorder } = createClient({ rows: [userRow({ full_name: 'Renamed' })] });
    const response = await call(`/api/admin/users/${TARGET}`, {
      method: 'PATCH',
      body: { fullName: 'Renamed' },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.fullName, 'Renamed');
    assert.deepEqual(recorder.argsFor('update'), [{ full_name: 'Renamed' }]);
  });

  it('toggles activation on another account', async () => {
    const { call, recorder } = createClient({ rows: [userRow({ is_active: false })] });
    const response = await call(`/api/admin/users/${TARGET}/active`, {
      method: 'POST',
      body: { isActive: false },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.isActive, false);
    assert.deepEqual(recorder.argsFor('update'), [{ is_active: false }]);
  });

  it('grants a role, returning 201 and the grant’s Location', async () => {
    const { call } = createClient({ rows: [grantRow()] });
    const response = await call(`/api/admin/users/${TARGET}/roles`, {
      method: 'POST',
      body: { roleId: ROLE_ID },
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location'), `/api/admin/users/${TARGET}/roles/${GRANT_ID}`);
    assert.equal((await response.json()).data.roleKey, 'secretary');
  });

  it('revokes a grant with 204 and no body', async () => {
    const { call } = createClient({ rows: [{ id: GRANT_ID }] });
    const response = await call(`/api/admin/users/${TARGET}/roles/${GRANT_ID}`, {
      method: 'DELETE',
    });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  });

  /* ---- self-service refusals, returned early as a legible 403 ------------- */

  it('refuses a user’s attempt to change their own activation, writing nothing', async () => {
    const { call, recorder } = createClient({ rows: [userRow()] });
    const response = await call('/api/admin/users/user-17/active', {
      method: 'POST',
      body: { isActive: false },
    });
    assert.equal(response.status, 403);
    assert.equal(recorder.called('update'), false);
  });

  it('refuses a user’s attempt to grant themselves a role, writing nothing', async () => {
    const { call, recorder } = createClient({ rows: [grantRow()] });
    const response = await call('/api/admin/users/user-17/roles', {
      method: 'POST',
      body: { roleId: ROLE_ID },
    });
    assert.equal(response.status, 403);
    assert.equal(recorder.called('insert'), false);
  });

  it('refuses a user’s attempt to revoke one of their own grants, writing nothing', async () => {
    const { call, recorder } = createClient({ rows: [{ id: GRANT_ID }] });
    const response = await call(`/api/admin/users/user-17/roles/${GRANT_ID}`, { method: 'DELETE' });
    assert.equal(response.status, 403);
    assert.equal(recorder.called('delete'), false);
  });

  /* ---- the permission matrix at the edge --------------------------------- */

  it('lets a users.view holder read, but refuses every write', async () => {
    const admin = fakeAdmin();
    const { call, recorder } = createClient({ as: 'user-18', admin, rows: [userRow()] });

    assert.equal((await call('/api/admin/users')).status, 200);
    assert.equal((await call(`/api/admin/users/${TARGET}`)).status, 200);
    assert.equal((await call('/api/admin/users/roles')).status, 200);

    const writes = [
      ['/api/admin/users', 'POST', { email: 'x@church.test', fullName: 'Ny' }],
      [`/api/admin/users/${TARGET}`, 'PATCH', { fullName: 'Ny' }],
      [`/api/admin/users/${TARGET}/active`, 'POST', { isActive: false }],
      [`/api/admin/users/${TARGET}/roles`, 'POST', { roleId: ROLE_ID }],
    ];
    for (const [path, method, body] of writes) {
      assert.equal((await call(path, { method, body })).status, 403, `${method} ${path}`);
    }
    assert.equal(
      (await call(`/api/admin/users/${TARGET}/roles/${GRANT_ID}`, { method: 'DELETE' })).status,
      403,
    );

    // Nothing reached the database, on either client.
    assert.equal(admin.calls.invited.length, 0);
    assert.equal(recorder.called('insert'), false);
    assert.equal(recorder.called('update'), false);
    assert.equal(recorder.called('delete'), false);
  });

  it('refuses even the list to a caller holding no users.* permission', async () => {
    const { call } = createClient({ as: 'user-2', rows: [userRow()] });
    assert.equal((await call('/api/admin/users')).status, 403);
    assert.equal(
      (
        await call('/api/admin/users', {
          method: 'POST',
          body: { email: 'x@church.test', fullName: 'Ny' },
        })
      ).status,
      403,
    );
  });

  /* ---- validation at the edge -------------------------------------------- */

  it('rejects a malformed invite, edit, activation, or grant with 422, writing nothing', async () => {
    const admin = fakeAdmin();
    const { call, recorder } = createClient({ admin, rows: [userRow()] });

    const bad = [
      ['/api/admin/users', 'POST', { email: 'a@b.com' }], // no name
      [`/api/admin/users/${TARGET}`, 'PATCH', { isActive: false }], // activation cannot ride in
      [`/api/admin/users/${TARGET}/active`, 'POST', { isActive: 'yes' }], // not a boolean
      [`/api/admin/users/${TARGET}/roles`, 'POST', { roleId: 'not-a-uuid' }], // not a uuid
    ];
    for (const [path, method, body] of bad) {
      assert.equal((await call(path, { method, body })).status, 422, `${method} ${path}`);
    }

    assert.equal(admin.calls.invited.length, 0);
    assert.equal(recorder.called('insert'), false);
    assert.equal(recorder.called('update'), false);
  });
});
