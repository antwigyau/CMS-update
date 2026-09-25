/**
 * The audit trail: writing (best-effort) and reading (behind audit.view).
 *
 * The property worth proving about writing is that it never fails the operation
 * it records — a thrown client must not become a 500 on a member edit that already
 * succeeded. The property worth proving about reading is the gate, and that the
 * query is ordered newest-first and capped by pagination.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import {
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });

const fakeContext = () => ({
  session: { accessToken: 't' },
  ip: '203.0.113.7',
  requestId: 'req-1',
  request: { headers: new Headers({ 'user-agent': 'test-agent' }) },
  logger: { warn: () => {} },
});

/* ---- writing ------------------------------------------------------------- */

describe('audit.record', () => {
  it('calls app.log_audit with the action, resource, and request context', async () => {
    const recorder = createQueryRecorder();
    const audit = createAuditService({ getClient: recorder.getClient });

    await audit.record(fakeContext(), {
      action: 'member.updated',
      resourceType: 'member',
      resourceId: 'mem-1',
      changes: { fields: ['phone'] },
      branchId: 'branch-1',
    });

    assert.equal(recorder.rpcCalls.length, 1);
    const { name, params } = recorder.rpcCalls[0];
    assert.equal(name, 'log_audit');
    assert.equal(params.p_action, 'member.updated');
    assert.equal(params.p_resource_type, 'member');
    assert.equal(params.p_resource_id, 'mem-1');
    assert.deepEqual(params.p_changes, { fields: ['phone'] });
    assert.equal(params.p_ip, '203.0.113.7');
    assert.equal(params.p_user_agent, 'test-agent');
    assert.equal(params.p_request_id, 'req-1');
  });

  it('coerces a non-string resource id to text (the column is text)', async () => {
    const recorder = createQueryRecorder();
    const audit = createAuditService({ getClient: recorder.getClient });

    await audit.record(fakeContext(), { action: 'x.created', resourceType: 'x', resourceId: 42 });
    assert.equal(recorder.rpcCalls[0].params.p_resource_id, '42');
  });

  it('never throws, even when the client cannot be built', async () => {
    const audit = createAuditService({
      getClient: () => {
        throw new Error('supabase not configured');
      },
    });

    await assert.doesNotReject(() =>
      audit.record(fakeContext(), { action: 'member.created', resourceType: 'member' }),
    );
  });
});

/* ---- reading ------------------------------------------------------------- */

describe('audit.list', () => {
  it('orders newest-first, filters, and paginates', async () => {
    const recorder = createQueryRecorder({ rows: [], count: 0 });
    const audit = createAuditService({ getClient: recorder.getClient });

    await audit.list({
      accessToken: 't',
      action: 'transaction.approved',
      from: '2026-09-01',
      pagination: { from: 0, to: 24 },
    });

    assert.ok(recorder.tables().includes('audit_logs'));
    assert.deepEqual(recorder.argsFor('eq'), ['action', 'transaction.approved']);
    assert.deepEqual(recorder.argsFor('gte'), ['occurred_at', '2026-09-01']);
    assert.deepEqual(recorder.argsFor('order'), ['occurred_at', { ascending: false }]);
    assert.deepEqual(recorder.argsFor('range'), [0, 24]);
  });
});

/* ---- the route ----------------------------------------------------------- */

function createClient({ as = 'user-15', ...recorderOptions } = {}) {
  const recorder = createQueryRecorder(recorderOptions);
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    audit: createAuditService({ getClient: recorder.getClient }),
  });

  const token = mintToken({ sub: as });
  const csrf = 'a'.repeat(64);

  return (path) =>
    handleRequest(
      new Request(`http://localhost:3000${path}`, {
        method: 'GET',
        headers: { 'sec-fetch-site': 'same-origin', cookie: `cma_at=${token}; cma_csrf=${csrf}` },
      }),
      { router, sink: () => {} },
    );
}

describe('GET /api/admin/audit', () => {
  it('registers one route, gated on audit.view, not public', () => {
    const routes = buildRouter({
      cfg,
      provider: createFakeProvider({}).provider,
      loadIdentity: createFakeIdentityLoader({}),
      audit: createAuditService({ getClient: createQueryRecorder().getClient }),
    })
      .list()
      .filter((route) => route.pattern.startsWith('/admin/audit'));

    assert.equal(routes.length, 1);
    assert.equal(routes[0].method, 'GET');
    assert.equal(routes[0].isPublic, false);
    assert.equal(routes[0].permission, 'audit.view');
  });

  it('returns the trail to a caller with audit.view', async () => {
    const call = createClient({
      rows: [
        {
          id: 1,
          occurred_at: '2026-09-01T00:00:00Z',
          actor_email: 'admin@church.test',
          actor_name: 'Admin',
          action: 'member.updated',
          resource_type: 'member',
          resource_id: 'mem-1',
          branch_id: null,
          changes: { fields: ['phone'] },
          ip: null,
          request_id: 'req-1',
        },
      ],
      count: 1,
    });

    const response = await call('/api/admin/audit');
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data[0].action, 'member.updated');
    assert.equal(data[0].actorEmail, 'admin@church.test');
  });

  it('refuses a caller without audit.view', async () => {
    const call = createClient({ as: 'user-2', rows: [], count: 0 });
    const response = await call('/api/admin/audit');
    assert.equal(response.status, 403);
  });

  it('rejects a bad date filter with a 422', async () => {
    const call = createClient({ rows: [], count: 0 });
    const response = await call('/api/admin/audit?from=yesterday');
    assert.equal(response.status, 422);
  });
});
