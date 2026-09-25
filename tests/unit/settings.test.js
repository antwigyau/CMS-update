/**
 * Settings admin — the in-app home for church-wide configuration.
 *
 * The permission that matters is `settings.manage`: it gates BOTH reading the list
 * and writing a value, because the editing screen belongs to whoever may change
 * settings, not merely see them. 'user-16' holds it; 'user-1' holds only
 * `settings.view` (an RLS read grant used elsewhere) and 'user-2' holds neither —
 * both are refused here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createSettingsService } from '../../src/services/settings.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import { settingUpdateSchema } from '../../src/validation/settings.schemas.js';
import {
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });

const settingRow = (o = {}) => ({
  id: '33333333-4444-4555-8666-777777777777',
  scope: 'global',
  branch_id: null,
  key: 'finance.currency',
  value: 'GHS',
  description: 'The currency all money is recorded in.',
  is_public: true,
  updated_at: '2026-09-20T10:00:00.000Z',
  ...o,
});

function createClient({ as = 'user-16', ...recorderOptions } = {}) {
  const recorder = createQueryRecorder(recorderOptions);
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    settings: createSettingsService({ getClient: recorder.getClient }),
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

  return { call, recorder };
}

/* ---- route table --------------------------------------------------------- */

describe('the settings route table', () => {
  const routes = buildRouter({
    cfg,
    provider: createFakeProvider({}).provider,
    loadIdentity: createFakeIdentityLoader({}),
    settings: createSettingsService({ getClient: createQueryRecorder().getClient }),
  })
    .list()
    .filter((route) => route.pattern.startsWith('/admin/settings'));

  it('registers two routes, neither public', () => {
    assert.equal(routes.length, 2);
    for (const route of routes) assert.equal(route.isPublic, false);
  });

  it('gates both the list and the edit on settings.manage', () => {
    const find = (method, pattern) =>
      routes.find((r) => r.method === method && r.pattern === pattern)?.permission;

    assert.equal(find('GET', '/admin/settings'), 'settings.manage');
    assert.equal(find('PATCH', '/admin/settings/:key'), 'settings.manage');
  });
});

/* ---- validation ---------------------------------------------------------- */

describe('settings validation', () => {
  it('accepts any JSON value — scalar, object, or array', () => {
    for (const value of ['GHS', 42, true, null, { nested: 1 }, [1, 2, 3]]) {
      assert.equal(settingUpdateSchema.safeParse({ value }).success, true);
    }
  });

  it('requires the value key', () => {
    assert.equal(settingUpdateSchema.safeParse({}).success, false);
  });

  it('rejects unknown keys, so a client cannot smuggle a scope or updated_by', () => {
    assert.equal(settingUpdateSchema.safeParse({ value: 'GHS', scope: 'branch' }).success, false);
    assert.equal(settingUpdateSchema.safeParse({ value: 'x', updatedBy: 'user-2' }).success, false);
  });
});

/* ---- service ------------------------------------------------------------- */

describe('the settings service', () => {
  it('lists only global settings, ordered by key', async () => {
    const recorder = createQueryRecorder({ rows: [settingRow()] });
    const settings = createSettingsService({ getClient: recorder.getClient });

    await settings.list({ accessToken: 't' });
    assert.deepEqual(recorder.argsFor('eq'), ['scope', 'global']);
    assert.deepEqual(recorder.argsFor('order'), ['key', { ascending: true }]);
  });

  it('updates by (scope, key) and stamps updated_by from the caller', async () => {
    const recorder = createQueryRecorder({ rows: [settingRow()] });
    const settings = createSettingsService({ getClient: recorder.getClient });

    await settings.update({
      accessToken: 't',
      key: 'finance.currency',
      value: 'GHS',
      updatedBy: 'user-16',
    });

    assert.deepEqual(recorder.argsFor('update'), [{ value: 'GHS', updated_by: 'user-16' }]);
    const eqs = recorder.allArgsFor('eq');
    assert.ok(eqs.some(([c, v]) => c === 'scope' && v === 'global'));
    assert.ok(eqs.some(([c, v]) => c === 'key' && v === 'finance.currency'));
  });

  it('rejects an update to a key that does not exist', async () => {
    const recorder = createQueryRecorder({ rows: [] });
    const settings = createSettingsService({ getClient: recorder.getClient });

    await assert.rejects(
      settings.update({ accessToken: 't', key: 'nope', value: 1, updatedBy: 'user-16' }),
      /does not exist/,
    );
  });
});

/* ---- routes -------------------------------------------------------------- */

describe('the settings endpoints', () => {
  it('lists the church settings for a settings admin', async () => {
    const { call } = createClient({ rows: [settingRow()] });
    const response = await call('/api/admin/settings');
    assert.equal(response.status, 200);

    const { data } = await response.json();
    assert.equal(data[0].key, 'finance.currency');
    assert.equal(data[0].isPublic, true);
  });

  it('updates a dotted key, routed intact through the :key segment', async () => {
    const { call, recorder } = createClient({ rows: [settingRow()] });
    const response = await call('/api/admin/settings/finance.currency', {
      method: 'PATCH',
      body: { value: 'GHS' },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.key, 'finance.currency');
    assert.ok(recorder.allArgsFor('eq').some(([c, v]) => c === 'key' && v === 'finance.currency'));
  });

  it('refuses the list to a caller holding only settings.view', async () => {
    const { call } = createClient({ as: 'user-1', rows: [settingRow()] });
    assert.equal((await call('/api/admin/settings')).status, 403);
  });

  it('refuses an edit to a caller holding only settings.view, and writes nothing', async () => {
    const { call, recorder } = createClient({ as: 'user-1', rows: [settingRow()] });
    const response = await call('/api/admin/settings/finance.currency', {
      method: 'PATCH',
      body: { value: 'USD' },
    });
    assert.equal(response.status, 403);
    assert.equal(recorder.called('update'), false);
  });

  it('refuses both the list and an edit to a caller holding neither permission', async () => {
    const { call, recorder } = createClient({ as: 'user-2', rows: [settingRow()] });

    assert.equal((await call('/api/admin/settings')).status, 403);

    const edit = await call('/api/admin/settings/finance.currency', {
      method: 'PATCH',
      body: { value: 'USD' },
    });
    assert.equal(edit.status, 403);
    assert.equal(recorder.called('update'), false);
  });

  it('rejects an unknown body field with 422, and writes nothing', async () => {
    const { call, recorder } = createClient({ rows: [settingRow()] });
    const response = await call('/api/admin/settings/finance.currency', {
      method: 'PATCH',
      body: { value: 'GHS', scope: 'branch' },
    });
    assert.equal(response.status, 422);
    assert.equal(recorder.called('update'), false);
  });
});
