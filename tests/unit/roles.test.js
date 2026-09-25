/**
 * Role-administration endpoints.
 *
 * `roles.manage` is a single global permission that gates the whole surface, so
 * these tests are less about branch scoping than about the two protections the
 * database does not provide: refusing to delete a role that is still in use, and
 * refusing to let an admin grant a role a permission they do not themselves hold
 * (the escalation guard). Both are exercised through the real router, guards,
 * validation, and error mapping — only the query builder is a fake.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createRolesService } from '../../src/services/roles.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import {
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import {
  PERM_EVENTS_VIEW,
  PERM_FINANCE_APPROVE,
  PERM_MEMBERS_VIEW,
  PERM_ROLES_MANAGE,
  PERM_UNKNOWN,
  ROLE_ID,
  permissionCatalogue,
  permissionRow,
  roleDetailRow,
  roleListRow,
  roleRow,
} from './roles-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });

/**
 * 'user-19' is the role administrator (roles.manage + members.view); 'user-18'
 * holds only users.view and stands in for a caller who reaches no route here.
 * Audit is a spy, so the success paths can be asserted without a live client.
 */
function createClient({ as = 'user-19', ...recorderOptions } = {}) {
  const recorder = createQueryRecorder(recorderOptions);
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });
  const auditRecords = [];

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    roles: createRolesService({ getClient: recorder.getClient }),
    audit: {
      record: async (_context, entry) => {
        auditRecords.push(entry);
      },
      list: async () => ({ rows: [], total: 0 }),
    },
  });

  const token = mintToken({ sub: as });
  const csrf = 'c'.repeat(64);

  async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const requestHeaders = {
      'sec-fetch-site': 'same-origin',
      cookie: `cma_at=${token}; cma_csrf=${csrf}`,
      'x-csrf-token': csrf,
      ...headers,
    };
    for (const [name, value] of Object.entries(requestHeaders)) {
      if (value === null) delete requestHeaders[name];
    }
    if (body !== undefined) requestHeaders['content-type'] = 'application/json';

    return handleRequest(
      new Request(`http://localhost:3000${path}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { router, sink: () => {} },
    );
  }

  return { call, recorder, auditRecords };
}

/* -------------------------------------------------------------------------- */

describe('the roles route table', () => {
  const routes = buildRouter({
    cfg,
    provider: createFakeProvider({}).provider,
    loadIdentity: createFakeIdentityLoader({}),
    roles: createRolesService({ getClient: createQueryRecorder().getClient }),
  })
    .list()
    .filter((route) => route.pattern.startsWith('/admin/roles'));

  it('registers seven routes, every one gated on roles.manage', () => {
    assert.equal(routes.length, 7);
    for (const route of routes) {
      assert.equal(route.isPublic, false);
      assert.equal(route.permission, 'roles.manage');
      assert.equal(route.guard, 'permission', 'roles has no leadership path');
    }
  });

  it('registers the literal /permissions before the :id parameter route', () => {
    const patterns = routes.map((route) => `${route.method} ${route.pattern}`);
    const literal = patterns.indexOf('GET /admin/roles/permissions');
    const parameter = patterns.indexOf('GET /admin/roles/:id');

    assert.ok(literal >= 0 && parameter >= 0);
    assert.ok(literal < parameter, '"permissions" must not be captured as an :id');
  });
});

describe('GET /api/admin/roles', () => {
  it('refuses a caller without roles.manage, before any query', async () => {
    const client = createClient({ as: 'user-18' });
    const response = await client.call('/api/admin/roles');

    assert.equal(response.status, 403);
    assert.deepEqual(client.recorder.tables(), []);
  });

  it('returns the roster with permission and grant counts', async () => {
    const client = createClient({ perTable: { roles: { rows: [roleListRow()] } } });
    const response = await client.call('/api/admin/roles');

    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data[0].key, 'finance_officer');
    assert.equal(data[0].permissionCount, 4);
    assert.equal(data[0].grantCount, 2);
    assert.equal(data[0].isSystem, false);
  });
});

describe('GET /api/admin/roles/permissions', () => {
  it('returns the catalogue grouped, not "permissions" read as an id', async () => {
    const client = createClient({ perTable: { permissions: { rows: [permissionRow()] } } });
    const response = await client.call('/api/admin/roles/permissions');

    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data[0].key, 'members.view');
    assert.equal(data[0].resource, 'members');
    assert.equal(data[0].group, 'members', 'group_key is mapped to group');
  });
});

describe('GET /api/admin/roles/:id', () => {
  it('returns the editor view: the role, its permission ids, and its use', async () => {
    const client = createClient({ perTable: { roles: { rows: [roleDetailRow()] } } });
    const response = await client.call(`/api/admin/roles/${ROLE_ID}`);

    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.key, 'finance_officer');
    assert.deepEqual(data.permissionIds, [PERM_ROLES_MANAGE]);
    assert.equal(data.grantCount, 0);
    assert.equal(data.isSystem, false);
  });

  it('is a 404 when the id matches nothing', async () => {
    const client = createClient({ perTable: { roles: { rows: [] } } });
    const response = await client.call(`/api/admin/roles/${ROLE_ID}`);

    assert.equal(response.status, 404);
    assert.deepEqual(client.recorder.tables(), ['roles']);
  });
});

describe('POST /api/admin/roles', () => {
  it('creates a role, defaulting sort order and never accepting is_system', async () => {
    const client = createClient({ perTable: { roles: { rows: [roleRow()] } } });
    const response = await client.call('/api/admin/roles', {
      method: 'POST',
      body: { key: 'finance_officer', name: 'Finance officer' },
    });

    assert.equal(response.status, 201);
    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.key, 'finance_officer');
    assert.equal(row.name, 'Finance officer');
    assert.equal(row.sort_order, 100);
    assert.equal('is_system' in row, false, 'is_system is the DB default, never client input');
  });

  it('passes an explicit description and sort order straight through', async () => {
    const client = createClient({ perTable: { roles: { rows: [roleRow()] } } });
    await client.call('/api/admin/roles', {
      method: 'POST',
      body: {
        key: 'finance_officer',
        name: 'Finance officer',
        description: 'Keeps books.',
        sortOrder: 40,
      },
    });

    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.description, 'Keeps books.');
    assert.equal(row.sort_order, 40);
  });

  it('rejects a malformed key with a 422 before any insert', async () => {
    const client = createClient();
    const response = await client.call('/api/admin/roles', {
      method: 'POST',
      body: { key: 'Bad Key', name: 'Finance officer' },
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('maps a duplicate key to a 409 on the field, never leaking the constraint', async () => {
    const client = createClient({
      perTable: {
        roles: {
          error: {
            code: '23505',
            message: 'duplicate key value violates unique constraint "roles_key_key"',
          },
        },
      },
    });
    const response = await client.call('/api/admin/roles', {
      method: 'POST',
      body: { key: 'finance_officer', name: 'Finance officer' },
    });

    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error.details.fields.key, /already exists/i);
    assert.doesNotMatch(JSON.stringify(body), /roles_key_key/, 'the constraint name must not leak');
  });
});

describe('PATCH /api/admin/roles/:id', () => {
  it('sends only the changed fields, in snake_case', async () => {
    const client = createClient({ perTable: { roles: { rows: [roleRow({ name: 'Renamed' })] } } });
    const response = await client.call(`/api/admin/roles/${ROLE_ID}`, {
      method: 'PATCH',
      body: { name: 'Renamed' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [{ name: 'Renamed' }]);
  });

  it('refuses an empty patch before touching the database', async () => {
    const client = createClient();
    const response = await client.call(`/api/admin/roles/${ROLE_ID}`, {
      method: 'PATCH',
      body: {},
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('update'), false);
  });

  it('rejects a name that is too short', async () => {
    const client = createClient();
    const response = await client.call(`/api/admin/roles/${ROLE_ID}`, {
      method: 'PATCH',
      body: { name: 'a' },
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('update'), false);
  });
});

describe('PUT /api/admin/roles/:id/permissions', () => {
  // The role carries roles.manage + events.view; the catalogue is the four known
  // permissions. role_permissions returns nothing — the writes are not read back.
  const withRoleAndCatalogue = () => ({
    perTable: {
      roles: {
        rows: [
          roleDetailRow({
            role_permissions: [
              { permission_id: PERM_ROLES_MANAGE },
              { permission_id: PERM_EVENTS_VIEW },
            ],
          }),
        ],
      },
      permissions: { rows: permissionCatalogue() },
      role_permissions: { rows: [] },
    },
  });

  it('writes exactly the add/remove diff and audits the change in keys', async () => {
    const client = createClient(withRoleAndCatalogue());
    const response = await client.call(`/api/admin/roles/${ROLE_ID}/permissions`, {
      method: 'PUT',
      body: { permissionIds: [PERM_ROLES_MANAGE, PERM_MEMBERS_VIEW] },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('in'), ['permission_id', [PERM_EVENTS_VIEW]]);
    assert.deepEqual(client.recorder.argsFor('insert')[0], [
      { role_id: ROLE_ID, permission_id: PERM_MEMBERS_VIEW },
    ]);

    const [entry] = client.auditRecords;
    assert.equal(entry.action, 'role.permissions_updated');
    assert.deepEqual(entry.changes, { added: ['members.view'], removed: ['events.view'] });
  });

  it('refuses to add a permission the acting admin does not hold', async () => {
    const client = createClient(withRoleAndCatalogue());
    const response = await client.call(`/api/admin/roles/${ROLE_ID}/permissions`, {
      method: 'PUT',
      body: { permissionIds: [PERM_ROLES_MANAGE, PERM_MEMBERS_VIEW, PERM_FINANCE_APPROVE] },
    });

    assert.equal(response.status, 403);
    assert.match((await response.json()).error.message, /finance\.approve/);
    assert.equal(client.recorder.called('insert'), false, 'nothing is written on refusal');
    assert.equal(client.recorder.called('delete'), false);
    assert.equal(client.auditRecords.length, 0);
  });

  it('rejects an id that is not in the catalogue', async () => {
    const client = createClient(withRoleAndCatalogue());
    const response = await client.call(`/api/admin/roles/${ROLE_ID}/permissions`, {
      method: 'PUT',
      body: { permissionIds: [PERM_ROLES_MANAGE, PERM_UNKNOWN] },
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.permissionIds, /does not exist/);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('handles a removal-only change without an insert', async () => {
    const client = createClient(withRoleAndCatalogue());
    const response = await client.call(`/api/admin/roles/${ROLE_ID}/permissions`, {
      method: 'PUT',
      body: { permissionIds: [PERM_ROLES_MANAGE] },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('in'), ['permission_id', [PERM_EVENTS_VIEW]]);
    assert.equal(client.recorder.called('insert'), false);
  });
});

describe('DELETE /api/admin/roles/:id', () => {
  it('refuses to delete a system role, and does not reach the database', async () => {
    const client = createClient({
      perTable: { roles: { rows: [roleDetailRow({ is_system: true })] } },
    });
    const response = await client.call(`/api/admin/roles/${ROLE_ID}`, { method: 'DELETE' });

    assert.equal(response.status, 409);
    assert.match((await response.json()).error.message, /system role/i);
    assert.equal(client.recorder.called('delete'), false);
  });

  it('refuses to delete a role that is still granted, spelling out why', async () => {
    const client = createClient({
      perTable: { roles: { rows: [roleDetailRow({ user_roles: [{ count: 3 }] })] } },
    });
    const response = await client.call(`/api/admin/roles/${ROLE_ID}`, { method: 'DELETE' });

    assert.equal(response.status, 409);
    assert.match((await response.json()).error.message, /Revoke those grants/);
    assert.equal(client.recorder.called('delete'), false);
  });

  it('deletes an unused custom role and audits it', async () => {
    const client = createClient({
      perTable: { roles: { rows: [roleDetailRow({ user_roles: [{ count: 0 }] })] } },
    });
    const response = await client.call(`/api/admin/roles/${ROLE_ID}`, { method: 'DELETE' });

    assert.equal(response.status, 204);
    assert.ok(client.recorder.called('delete'));
    assert.equal(client.auditRecords[0].action, 'role.deleted');
  });
});

describe('the roles.manage gate', () => {
  const routes = [
    ['GET', '/api/admin/roles'],
    ['POST', '/api/admin/roles'],
    ['GET', '/api/admin/roles/permissions'],
    ['GET', `/api/admin/roles/${ROLE_ID}`],
    ['PATCH', `/api/admin/roles/${ROLE_ID}`],
    ['PUT', `/api/admin/roles/${ROLE_ID}/permissions`],
    ['DELETE', `/api/admin/roles/${ROLE_ID}`],
  ];

  for (const [method, path] of routes) {
    it(`refuses ${method} ${path} for a caller without roles.manage`, async () => {
      const client = createClient({ as: 'user-18' });
      const body = ['POST', 'PATCH', 'PUT'].includes(method) ? {} : undefined;
      const response = await client.call(path, { method, body });

      assert.equal(response.status, 403);
      assert.deepEqual(client.recorder.tables(), [], 'refused before any database access');
    });
  }
});
