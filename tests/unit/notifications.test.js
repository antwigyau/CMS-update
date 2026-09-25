/**
 * Notification endpoints — the inbox everyone reads, and the publisher console.
 *
 * Two global permissions gate the surface: `notifications.view` for the inbox and
 * `notifications.create` for publishing. The tests run through the real router,
 * guards, validation, and error mapping; only the query builder is a fake, so the
 * assertions are about the query a handler builds and the audit it records — the
 * parts a mistake leaves silent. RLS itself is proven by the database tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createNotificationsService } from '../../src/services/notifications.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import {
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import {
  BRANCH_ID,
  NOTIFICATION_ID,
  ROLE_ID,
  branchOptionRow,
  inboxRow,
  notificationRow,
  publishedListRow,
  roleOptionRow,
} from './notifications-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });

/**
 * 'user-20' is the publisher (notifications.create + notifications.view +
 * users.view); 'user-21' holds only notifications.view (an ordinary recipient);
 * 'user-2' holds neither. Audit is a spy, so the publish/retract success paths
 * can be asserted without a live client.
 */
function createClient({ as = 'user-20', ...recorderOptions } = {}) {
  const recorder = createQueryRecorder(recorderOptions);
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });
  const auditRecords = [];

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    notifications: createNotificationsService({ getClient: recorder.getClient }),
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
/** A valid compose payload; override a field to exercise one rule at a time. */
function publishBody(overrides = {}) {
  return {
    title: 'Harvest service moved to 9am',
    body: 'The harvest service now begins at 9am. Please arrive early.',
    audience: 'all',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

describe('the notifications route table', () => {
  const routes = buildRouter({
    cfg,
    provider: createFakeProvider({}).provider,
    loadIdentity: createFakeIdentityLoader({}),
    notifications: createNotificationsService({ getClient: createQueryRecorder().getClient }),
  })
    .list()
    .filter(
      (route) =>
        route.pattern === '/notifications' ||
        route.pattern.startsWith('/notifications/') ||
        route.pattern.startsWith('/admin/notifications'),
    );

  it('registers nine routes, every one guarded on a permission', () => {
    assert.equal(routes.length, 9);
    for (const route of routes) {
      assert.equal(route.isPublic, false);
      assert.equal(route.guard, 'permission', 'notifications has no leadership path');
    }
  });

  it('gates the inbox on notifications.view and the console on notifications.create', () => {
    const permissionOf = (method, pattern) =>
      routes.find((route) => route.method === method && route.pattern === pattern)?.permission;

    assert.equal(permissionOf('GET', '/notifications'), 'notifications.view');
    assert.equal(permissionOf('GET', '/notifications/unread-count'), 'notifications.view');
    assert.equal(permissionOf('POST', '/notifications/read-all'), 'notifications.view');
    assert.equal(permissionOf('POST', '/notifications/:id/read'), 'notifications.view');

    assert.equal(permissionOf('GET', '/admin/notifications'), 'notifications.create');
    assert.equal(permissionOf('GET', '/admin/notifications/audiences'), 'notifications.create');
    assert.equal(permissionOf('POST', '/admin/notifications'), 'notifications.create');
    assert.equal(permissionOf('GET', '/admin/notifications/:id'), 'notifications.create');
    assert.equal(permissionOf('DELETE', '/admin/notifications/:id'), 'notifications.create');
  });

  it('registers the literal /audiences before the :id parameter route', () => {
    const patterns = routes.map((route) => `${route.method} ${route.pattern}`);
    const literal = patterns.indexOf('GET /admin/notifications/audiences');
    const parameter = patterns.indexOf('GET /admin/notifications/:id');

    assert.ok(literal >= 0 && parameter >= 0);
    assert.ok(literal < parameter, '"audiences" must not be captured as an :id');
  });
});
describe('GET /api/notifications (the inbox)', () => {
  it('maps rows to the camelCase inbox view with a read boolean', async () => {
    const client = createClient({
      as: 'user-21',
      perTable: { notifications: { rows: [inboxRow()] } },
    });
    const response = await client.call('/api/notifications');

    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data[0].id, NOTIFICATION_ID);
    assert.equal(data[0].title, 'Harvest service moved to 9am');
    assert.equal(data[0].read, false, 'a null read_at is unread');
    assert.equal('body' in data[0], true);
    assert.equal('notification_recipients' in data[0], false, 'the join is not leaked');
  });

  it('reports a delivered row as read once its read_at is set', async () => {
    const client = createClient({
      as: 'user-21',
      perTable: {
        notifications: {
          rows: [
            inboxRow({
              notification_recipients: [
                { read_at: '2026-09-21T00:00:00.000Z', user_id: 'user-21' },
              ],
            }),
          ],
        },
      },
    });
    const response = await client.call('/api/notifications');

    const { data } = await response.json();
    assert.equal(data[0].read, true);
  });

  it('filters to the caller and to live notifications', async () => {
    const client = createClient({
      as: 'user-21',
      perTable: { notifications: { rows: [inboxRow()] } },
    });
    await client.call('/api/notifications');

    assert.deepEqual(client.recorder.argsFor('eq'), ['notification_recipients.user_id', 'user-21']);
    const [expiry] = client.recorder.argsFor('or');
    assert.match(expiry, /expires_at\.is\.null/);
    assert.match(expiry, /expires_at\.gt\./);
  });
});

describe('GET /api/notifications/unread-count', () => {
  it('returns the count as a bare number', async () => {
    const client = createClient({
      as: 'user-21',
      perTable: { notification_recipients: { count: 3 } },
    });
    const response = await client.call('/api/notifications/unread-count');

    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { count: 3 });
    assert.deepEqual(client.recorder.argsFor('is'), ['read_at', null], 'only unread rows');
  });
});
describe('marking read', () => {
  it('POST /:id/read updates read_at, scoped to the caller and that notification', async () => {
    const client = createClient({ as: 'user-21' });
    const response = await client.call(`/api/notifications/${NOTIFICATION_ID}/read`, {
      method: 'POST',
    });

    assert.equal(response.status, 204);
    const [patch] = client.recorder.argsFor('update');
    assert.equal('read_at' in patch, true);
    const eqs = client.recorder.allArgsFor('eq');
    assert.deepEqual(eqs, [
      ['notification_id', NOTIFICATION_ID],
      ['user_id', 'user-21'],
    ]);
  });

  it('POST /read-all updates every unread row for the caller', async () => {
    const client = createClient({ as: 'user-21' });
    const response = await client.call('/api/notifications/read-all', { method: 'POST' });

    assert.equal(response.status, 204);
    const [patch] = client.recorder.argsFor('update');
    assert.equal('read_at' in patch, true);
    assert.deepEqual(client.recorder.argsFor('eq'), ['user_id', 'user-21']);
    assert.deepEqual(client.recorder.argsFor('is'), ['read_at', null]);
  });
});
describe('GET /api/admin/notifications (the published list)', () => {
  it('returns rows with a recipient count and the page total', async () => {
    const client = createClient({
      perTable: { notifications: { rows: [publishedListRow()], count: 1 } },
    });
    const response = await client.call('/api/admin/notifications');

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data[0].id, NOTIFICATION_ID);
    assert.equal(body.data[0].recipientCount, 5, 'the embedded count is surfaced');
    assert.equal(body.meta.total, 1);
  });
});

describe('GET /api/admin/notifications/:id (detail)', () => {
  it('returns the full view plus its recipient count', async () => {
    const client = createClient({
      perTable: { notifications: { rows: [publishedListRow()] } },
    });
    const response = await client.call(`/api/admin/notifications/${NOTIFICATION_ID}`);

    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.id, NOTIFICATION_ID);
    assert.equal(data.audience, 'all');
    assert.equal(data.recipientCount, 5);
  });

  it('is a 404 when the id matches nothing', async () => {
    const client = createClient({ perTable: { notifications: { rows: [] } } });
    const response = await client.call(`/api/admin/notifications/${NOTIFICATION_ID}`);

    assert.equal(response.status, 404);
  });
});

describe('GET /api/admin/notifications/audiences (the compose pickers)', () => {
  it('returns roles and branches mapped to option views', async () => {
    const client = createClient({
      perTable: {
        roles: { rows: [roleOptionRow()] },
        branches: { rows: [branchOptionRow()] },
      },
    });
    const response = await client.call('/api/admin/notifications/audiences');

    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(data.roles[0], {
      id: ROLE_ID,
      key: 'finance_officer',
      name: 'Finance officer',
    });
    assert.deepEqual(data.branches[0], { id: BRANCH_ID, name: 'Main campus' });
  });
});
describe('POST /api/admin/notifications (publish)', () => {
  it('publishes to everyone: stamps created_by, fans out, and audits the reach', async () => {
    const client = createClient({
      perTable: {
        notifications: { rows: [notificationRow()] },
        profiles: { rows: [{ id: 'user-a' }, { id: 'user-b' }] },
      },
    });
    const response = await client.call('/api/admin/notifications', {
      method: 'POST',
      body: publishBody(),
    });

    assert.equal(response.status, 201);

    // The first insert is the notification; created_by is the session, never input.
    const inserts = client.recorder.allArgsFor('insert');
    const [notificationRowArg] = inserts[0];
    assert.equal(notificationRowArg.created_by, 'user-20');
    assert.equal(notificationRowArg.audience, 'all');

    // The second insert is the delivery fan-out, one row per resolved user.
    assert.deepEqual(inserts[1][0], [
      { notification_id: NOTIFICATION_ID, user_id: 'user-a' },
      { notification_id: NOTIFICATION_ID, user_id: 'user-b' },
    ]);

    const [entry] = client.auditRecords;
    assert.equal(entry.action, 'notification.published');
    assert.equal(entry.resourceId, NOTIFICATION_ID);
    assert.deepEqual(entry.changes, {
      type: 'announcement',
      severity: 'info',
      audience: 'all',
      recipientCount: 2,
    });

    assert.equal((await response.json()).data.recipientCount, 2);
  });

  it('resolves a role audience from user_roles, deduping multi-branch grants', async () => {
    const client = createClient({
      perTable: {
        notifications: { rows: [notificationRow({ audience: 'role', audience_role_id: ROLE_ID })] },
        user_roles: { rows: [{ user_id: 'user-a' }, { user_id: 'user-b' }, { user_id: 'user-a' }] },
      },
    });
    const response = await client.call('/api/admin/notifications', {
      method: 'POST',
      body: publishBody({ audience: 'role', audienceRoleId: ROLE_ID }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(client.recorder.argsFor('eq'), ['role_id', ROLE_ID]);
    assert.ok(client.recorder.tables().includes('user_roles'));
    assert.equal(
      client.recorder.tables().includes('profiles'),
      false,
      'a role does not read profiles',
    );
    assert.deepEqual(client.recorder.allArgsFor('insert')[1][0], [
      { notification_id: NOTIFICATION_ID, user_id: 'user-a' },
      { notification_id: NOTIFICATION_ID, user_id: 'user-b' },
    ]);
  });
});
describe('POST /api/admin/notifications (audience edges and validation)', () => {
  it('resolves a branch audience from active profiles in that branch', async () => {
    const client = createClient({
      perTable: {
        notifications: { rows: [notificationRow({ audience: 'branch', branch_id: BRANCH_ID })] },
        profiles: { rows: [{ id: 'user-a' }] },
      },
    });
    const response = await client.call('/api/admin/notifications', {
      method: 'POST',
      body: publishBody({ audience: 'branch', branchId: BRANCH_ID }),
    });

    assert.equal(response.status, 201);
    const eqs = client.recorder.allArgsFor('eq');
    assert.deepEqual(eqs, [
      ['is_active', true],
      ['default_branch_id', BRANCH_ID],
    ]);
  });

  it('publishes to nobody without a delivery insert, recording a reach of zero', async () => {
    const client = createClient({
      perTable: {
        notifications: { rows: [notificationRow()] },
        profiles: { rows: [] },
      },
    });
    const response = await client.call('/api/admin/notifications', {
      method: 'POST',
      body: publishBody(),
    });

    assert.equal(response.status, 201);
    assert.equal(
      client.recorder.allArgsFor('insert').length,
      1,
      'only the notification is inserted',
    );
    assert.equal(client.recorder.tables().includes('notification_recipients'), false);
    assert.equal(client.auditRecords[0].changes.recipientCount, 0);
  });

  it('rejects an unknown key with a 422, before any insert (mass-assignment guard)', async () => {
    const client = createClient();
    const response = await client.call('/api/admin/notifications', {
      method: 'POST',
      body: publishBody({ createdBy: 'user-99' }),
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('insert'), false);
    assert.deepEqual(client.recorder.tables(), []);
  });

  it('rejects a role audience with no role chosen (audience coherence)', async () => {
    const client = createClient();
    const response = await client.call('/api/admin/notifications', {
      method: 'POST',
      body: publishBody({ audience: 'role' }),
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.audienceRoleId, /Choose a role/);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('rejects a title that is too short, before any insert', async () => {
    const client = createClient();
    const response = await client.call('/api/admin/notifications', {
      method: 'POST',
      body: publishBody({ title: 'a' }),
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('insert'), false);
  });
});
describe('DELETE /api/admin/notifications/:id (retract)', () => {
  it('is a 404 when the id matches nothing, and never deletes', async () => {
    const client = createClient({ perTable: { notifications: { rows: [] } } });
    const response = await client.call(`/api/admin/notifications/${NOTIFICATION_ID}`, {
      method: 'DELETE',
    });

    assert.equal(response.status, 404);
    assert.equal(client.recorder.called('delete'), false);
    assert.equal(client.auditRecords.length, 0);
  });

  it('deletes an existing notification and audits the retraction', async () => {
    const client = createClient({ perTable: { notifications: { rows: [notificationRow()] } } });
    const response = await client.call(`/api/admin/notifications/${NOTIFICATION_ID}`, {
      method: 'DELETE',
    });

    assert.equal(response.status, 204);
    assert.ok(client.recorder.called('delete'));
    const [entry] = client.auditRecords;
    assert.equal(entry.action, 'notification.deleted');
    assert.equal(entry.resourceId, NOTIFICATION_ID);
    assert.deepEqual(entry.changes, { type: 'announcement', audience: 'all' });
  });
});

describe('the permission gates', () => {
  const adminRoutes = [
    ['GET', '/api/admin/notifications'],
    ['GET', '/api/admin/notifications/audiences'],
    ['POST', '/api/admin/notifications'],
    ['GET', `/api/admin/notifications/${NOTIFICATION_ID}`],
    ['DELETE', `/api/admin/notifications/${NOTIFICATION_ID}`],
  ];

  for (const [method, path] of adminRoutes) {
    it(`refuses ${method} ${path} for a recipient without notifications.create`, async () => {
      const client = createClient({ as: 'user-21' });
      const body = method === 'POST' ? {} : undefined;
      const response = await client.call(path, { method, body });

      assert.equal(response.status, 403);
      assert.deepEqual(client.recorder.tables(), [], 'refused before any database access');
    });
  }

  const inboxRoutes = [
    ['GET', '/api/notifications'],
    ['GET', '/api/notifications/unread-count'],
    ['POST', '/api/notifications/read-all'],
    ['POST', `/api/notifications/${NOTIFICATION_ID}/read`],
  ];

  for (const [method, path] of inboxRoutes) {
    it(`refuses ${method} ${path} for a caller without notifications.view`, async () => {
      const client = createClient({ as: 'user-2' });
      const body = method === 'POST' ? {} : undefined;
      const response = await client.call(path, { method, body });

      assert.equal(response.status, 403);
      assert.deepEqual(client.recorder.tables(), [], 'refused before any database access');
    });
  }
});
