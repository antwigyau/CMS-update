/**
 * Member emergency contacts.
 *
 * A child resource guarded through its member: reading needs `members.view`,
 * writing `members.update`, and RLS narrows both to the member's branch (or the
 * member's own record) via `app.can_edit_member`. These tests prove the guards,
 * the strict validation, and that every query is scoped by `member_id` so a
 * contact cannot be reached through another member's path.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createMembersService } from '../../src/services/members.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import {
  emergencyContactCreateSchema,
  emergencyContactUpdateSchema,
} from '../../src/validation/emergency-contacts.schemas.js';
import {
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });
const MEMBER_ID = '11111111-2222-4333-8444-555555555555';
const CONTACT_ID = '99999999-8888-4777-8666-555555555555';

function contactRow(overrides = {}) {
  return {
    id: CONTACT_ID,
    member_id: MEMBER_ID,
    name: 'Ama Mensah',
    relationship: 'Spouse',
    phone: '+233201234567',
    alt_phone: null,
    address_line: null,
    is_primary: true,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

/** 'user-1' holds members.view + members.update; 'user-2' holds neither. */
function createClient({ as = 'user-1', ...recorderOptions } = {}) {
  const recorder = createQueryRecorder(recorderOptions);
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    members: createMembersService({ getClient: recorder.getClient }),
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

const base = `/api/members/${MEMBER_ID}/emergency-contacts`;

/* -------------------------------------------------------------------------- */

describe('the emergency-contact route table', () => {
  const routes = buildRouter({
    cfg,
    provider: createFakeProvider({}).provider,
    loadIdentity: createFakeIdentityLoader({}),
    members: createMembersService({ getClient: createQueryRecorder().getClient }),
  })
    .list()
    .filter((route) => route.pattern.includes('/emergency-contacts'));

  it('registers four routes: read on members.view, writes on members.update', () => {
    assert.equal(routes.length, 4);
    const decision = (method) => {
      const route = routes.find((item) => item.method === method);
      return route ? route.permission : null;
    };
    assert.equal(decision('GET'), 'members.view');
    assert.equal(decision('POST'), 'members.update');
    assert.equal(decision('PATCH'), 'members.update');
    assert.equal(decision('DELETE'), 'members.update');
    for (const route of routes) assert.equal(route.isPublic, false);
  });
});

/* ---- validation ---------------------------------------------------------- */

describe('emergency-contact validation', () => {
  it('requires a name, relationship, and phone', () => {
    assert.equal(emergencyContactCreateSchema.safeParse({}).success, false);
    assert.equal(
      emergencyContactCreateSchema.safeParse({ name: 'Ama', relationship: 'Spouse' }).success,
      false,
    );
  });

  it('accepts a full contact and defaults isPrimary to false', () => {
    const result = emergencyContactCreateSchema.safeParse({
      name: 'Ama Mensah',
      relationship: 'Spouse',
      phone: '+233201234567',
    });
    assert.equal(result.success, true);
    assert.equal(result.data.isPrimary, false);
  });

  it('rejects an unknown field (mass-assignment guard)', () => {
    const result = emergencyContactCreateSchema.safeParse({
      name: 'Ama',
      relationship: 'Spouse',
      phone: '+233201234567',
      memberId: MEMBER_ID,
    });
    assert.equal(result.success, false);
  });

  it('rejects a malformed phone number', () => {
    const result = emergencyContactCreateSchema.safeParse({
      name: 'Ama',
      relationship: 'Spouse',
      phone: 'call me',
    });
    assert.equal(result.success, false);
  });

  it('refuses an empty update', () => {
    assert.equal(emergencyContactUpdateSchema.safeParse({}).success, false);
  });
});

/* ---- service query shape ------------------------------------------------- */

describe('the emergency-contact service queries', () => {
  it('inserts with the member id stamped on the row', async () => {
    const recorder = createQueryRecorder({ rows: [contactRow()] });
    const members = createMembersService({ getClient: recorder.getClient });

    await members.createEmergencyContact({
      accessToken: 't',
      memberId: MEMBER_ID,
      row: { name: 'Ama', relationship: 'Spouse', phone: '+233201234567' },
    });

    assert.ok(recorder.tables().includes('member_emergency_contacts'));
    assert.equal(recorder.argsFor('insert')[0].member_id, MEMBER_ID);
  });

  it('scopes an update by both the contact id and the member id', async () => {
    const recorder = createQueryRecorder({ rows: [contactRow()] });
    const members = createMembersService({ getClient: recorder.getClient });

    await members.updateEmergencyContact({
      accessToken: 't',
      memberId: MEMBER_ID,
      id: CONTACT_ID,
      patch: { phone: '+233207654321' },
    });

    const eqs = recorder.allArgsFor('eq');
    assert.ok(eqs.some(([col, val]) => col === 'id' && val === CONTACT_ID));
    assert.ok(eqs.some(([col, val]) => col === 'member_id' && val === MEMBER_ID));
  });

  it('reports a missing contact as a 404', async () => {
    const recorder = createQueryRecorder({ rows: [] });
    const members = createMembersService({ getClient: recorder.getClient });

    await assert.rejects(
      () =>
        members.removeEmergencyContact({ accessToken: 't', memberId: MEMBER_ID, id: CONTACT_ID }),
      (error) => error.status === 404,
    );
  });
});

/* ---- routes -------------------------------------------------------------- */

describe('the emergency-contact endpoints', () => {
  it('lists a member’s contacts for a caller with members.view', async () => {
    const { call } = createClient({ rows: [contactRow()] });
    const response = await call(base);
    assert.equal(response.status, 200);

    const { data } = await response.json();
    assert.equal(data[0].name, 'Ama Mensah');
    assert.equal(data[0].isPrimary, true);
  });

  it('creates a contact for a caller with members.update', async () => {
    const { call } = createClient({ rows: [contactRow()] });
    const response = await call(base, {
      method: 'POST',
      body: { name: 'Ama Mensah', relationship: 'Spouse', phone: '+233201234567' },
    });
    assert.equal(response.status, 201);
  });

  it('rejects a malformed phone with a 422', async () => {
    const { call } = createClient({ rows: [] });
    const response = await call(base, {
      method: 'POST',
      body: { name: 'Ama', relationship: 'Spouse', phone: 'call me' },
    });
    assert.equal(response.status, 422);
  });

  it('refuses a caller who lacks members.view', async () => {
    const { call } = createClient({ as: 'user-2', rows: [] });
    const response = await call(base);
    assert.equal(response.status, 403);
  });

  it('refuses a write from a caller who lacks members.update', async () => {
    const { call } = createClient({ as: 'user-2', rows: [] });
    const response = await call(base, {
      method: 'POST',
      body: { name: 'Ama', relationship: 'Spouse', phone: '+233201234567' },
    });
    assert.equal(response.status, 403);
  });

  it('deletes a contact and answers 204', async () => {
    const { call } = createClient({ rows: [contactRow()] });
    const response = await call(`${base}/${CONTACT_ID}`, { method: 'DELETE' });
    assert.equal(response.status, 204);
  });
});
