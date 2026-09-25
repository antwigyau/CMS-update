/**
 * Household endpoints, end to end through the real router, guards, and validation.
 *
 * As with members, the Supabase client is a recorder, so these tests assert both
 * what the caller sees and the query that was built. The household-specific
 * concerns are the two uniqueness rules (one head, one household per member), and
 * that the branch for a membership write comes from the household row rather than
 * from the request.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createFamiliesService, escapeLikePattern } from '../../src/services/families.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import {
  BRANCH_MAIN,
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import {
  FAMILY_ID,
  MEMBER_ID,
  familyListRow,
  familyMemberRow,
  familyPayload,
  familyRow,
} from './families-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });

function createClient({ as = 'user-1', ...recorderOptions } = {}) {
  const recorder = createQueryRecorder(recorderOptions);
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    families: createFamiliesService({ getClient: recorder.getClient }),
  });

  const token = mintToken({ sub: as });
  const csrf = 'b'.repeat(64);

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

  return { call, recorder };
}

/* -------------------------------------------------------------------------- */

describe('the household route table', () => {
  const routes = buildRouter({
    cfg,
    provider: createFakeProvider({}).provider,
    loadIdentity: createFakeIdentityLoader({}),
    families: createFamiliesService({ getClient: createQueryRecorder().getClient }),
  })
    .list()
    .filter((route) => route.pattern.startsWith('/families'));

  it('registers eight routes, none of them public', () => {
    assert.equal(routes.length, 8);
    for (const route of routes) {
      assert.equal(route.isPublic, false);
      assert.ok(route.permission);
    }
  });

  it('guards membership changes with families.update, not a permission of its own', () => {
    const membershipRoutes = routes.filter((route) => route.pattern.includes('/members'));
    assert.equal(membershipRoutes.length, 3);
    for (const route of membershipRoutes) {
      assert.equal(route.permission, 'families.update');
    }
  });
});

describe('GET /api/families', () => {
  it('refuses a caller without families.view', async () => {
    const client = createClient({ as: 'user-2', rows: [] });
    const response = await client.call('/api/families');

    assert.equal(response.status, 403);
  });

  it('returns households with a member count', async () => {
    const client = createClient({ rows: [familyListRow()], count: 1 });
    const response = await client.call('/api/families');

    assert.equal(response.status, 200);
    const { data } = await response.json();

    assert.equal(data[0].familyName, 'The Mensah Family');
    assert.equal(data[0].memberCount, 4, 'read out of the embedded aggregate');
  });

  it('counts households in one request rather than one query per household', async () => {
    const client = createClient({ rows: [familyListRow()], count: 1 });
    await client.call('/api/families');

    const [columns] = client.recorder.argsFor('select');
    assert.match(columns, /family_members\(count\)/);
    assert.deepEqual(client.recorder.tables(), ['families']);
  });

  it('searches by name, case-insensitively', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/families?search=mensah');

    assert.deepEqual(client.recorder.argsFor('ilike'), ['family_name', '%mensah%']);
  });

  it('escapes wildcards, so "%" does not match every household', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/families?search=%25');

    assert.deepEqual(client.recorder.argsFor('ilike'), ['family_name', '%\\%%']);
  });

  it('does not search on whitespace', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/families?search=%20');

    assert.equal(client.recorder.called('ilike'), false);
  });

  it('sorts by name with a stable tiebreaker, and caps the page size', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/families?pageSize=5000');

    assert.deepEqual(client.recorder.allArgsFor('order'), [
      ['family_name', { ascending: true }],
      ['id', { ascending: true }],
    ]);
    assert.deepEqual(client.recorder.argsFor('range'), [0, 99]);
  });

  it('ignores a sort key outside the allow-list', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/families?sort=notes');

    assert.deepEqual(client.recorder.allArgsFor('order')[0], ['family_name', { ascending: true }]);
  });
});

describe('GET /api/families/:id', () => {
  it('returns the household with its members, the head singled out', async () => {
    const client = createClient({
      perTable: {
        families: { rows: [familyRow()] },
        family_members: {
          rows: [
            familyMemberRow({
              member_id: 'child-1',
              relationship: 'son',
              is_dependent: true,
              members: { full_name: 'Kwame Mensah', member_no: 'MAIN-000102' },
            }),
            familyMemberRow(),
          ],
        },
      },
    });

    const response = await client.call(`/api/families/${FAMILY_ID}`);
    assert.equal(response.status, 200);

    const { data } = await response.json();
    assert.equal(data.familyName, 'The Mensah Family');
    assert.equal(data.memberCount, 2);
    assert.equal(data.head.fullName, 'Grace Mensah');

    // The head reads first regardless of the order the database returned.
    assert.deepEqual(
      data.members.map((member) => member.relationship),
      ['head', 'son'],
    );
  });

  it('reports no head when the household has none, rather than inventing one', async () => {
    const client = createClient({
      perTable: {
        families: { rows: [familyRow()] },
        family_members: { rows: [familyMemberRow({ relationship: 'other' })] },
      },
    });

    const { data } = await (await client.call(`/api/families/${FAMILY_ID}`)).json();
    assert.equal(data.head, null);
  });

  it('reads the household first, so a hidden one 404s before the member query runs', async () => {
    const client = createClient({ perTable: { families: { rows: [] } } });
    const response = await client.call(`/api/families/${FAMILY_ID}`);

    assert.equal(response.status, 404);
    assert.deepEqual(client.recorder.tables(), ['families'], 'family_members must not be queried');
  });

  it('asks for only the member fields a household view needs', async () => {
    const client = createClient({
      perTable: { families: { rows: [familyRow()] }, family_members: { rows: [] } },
    });
    await client.call(`/api/families/${FAMILY_ID}`);

    const embedded = client.recorder.allArgsFor('select')[1][0];
    assert.match(embedded, /full_name/);
    assert.doesNotMatch(embedded, /notes/);
    assert.doesNotMatch(embedded, /address_line/);
    assert.doesNotMatch(embedded, /phone/);
  });
});

describe('POST /api/families', () => {
  it('creates a household in the caller’s branch', async () => {
    const client = createClient({ rows: [familyRow()] });
    const response = await client.call('/api/families', {
      method: 'POST',
      body: familyPayload(),
    });

    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location'), `/api/families/${FAMILY_ID}`);

    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.branch_id, BRANCH_MAIN);
    assert.equal(row.family_name, 'The Osei Household');
  });

  it('requires a household name of at least two characters', async () => {
    const client = createClient();
    const response = await client.call('/api/families', {
      method: 'POST',
      body: { familyName: 'X' },
    });

    assert.equal(response.status, 422);
    assert.ok((await response.json()).error.details.fields.familyName);
  });

  it('rejects an unknown field', async () => {
    const client = createClient();
    const response = await client.call('/api/families', {
      method: 'POST',
      body: familyPayload({ headMemberId: MEMBER_ID }),
    });

    assert.equal(response.status, 422);
  });

  it('turns a duplicate household name into a 409 without naming the constraint', async () => {
    const client = createClient({
      rows: [],
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "families_branch_name_key"',
      },
    });

    const response = await client.call('/api/families', { method: 'POST', body: familyPayload() });
    const body = await response.text();

    assert.equal(response.status, 409);
    assert.match(JSON.parse(body).error.details.fields.familyName, /already exists in this branch/);
    assert.doesNotMatch(body, /families_branch_name_key/);
  });

  it('refuses a caller without families.create', async () => {
    const client = createClient({ as: 'user-2', rows: [familyRow()] });
    const response = await client.call('/api/families', { method: 'POST', body: familyPayload() });

    assert.equal(response.status, 403);
  });
});

describe('PATCH /api/families/:id', () => {
  it('applies only the supplied fields', async () => {
    const client = createClient({ rows: [familyRow({ city: 'Kumasi' })] });
    const response = await client.call(`/api/families/${FAMILY_ID}`, {
      method: 'PATCH',
      body: { city: 'Kumasi' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [{ city: 'Kumasi' }]);
  });

  it('refuses an empty patch', async () => {
    const client = createClient({ rows: [familyRow()] });
    const response = await client.call(`/api/families/${FAMILY_ID}`, {
      method: 'PATCH',
      body: {},
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('update'), false);
  });

  it('will not move a household between branches', async () => {
    const client = createClient({ rows: [familyRow()] });
    const response = await client.call(`/api/families/${FAMILY_ID}`, {
      method: 'PATCH',
      body: { branchId: BRANCH_MAIN },
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('update'), false);
  });

  it('requires the CSRF token', async () => {
    const client = createClient({ rows: [familyRow()] });
    const response = await client.call(`/api/families/${FAMILY_ID}`, {
      method: 'PATCH',
      body: { city: 'Kumasi' },
      headers: { 'x-csrf-token': null },
    });

    assert.equal(response.status, 403);
  });
});

describe('DELETE /api/families/:id', () => {
  it('deletes the grouping — a hard delete, unlike a member', async () => {
    const client = createClient({ as: 'user-4', rows: [{ id: FAMILY_ID }] });
    const response = await client.call(`/api/families/${FAMILY_ID}`, { method: 'DELETE' });

    assert.equal(response.status, 204);
    assert.ok(client.recorder.called('delete'));
    assert.equal(client.recorder.called('update'), false, 'not a soft delete');
  });

  it('refuses a caller with families.update but not families.delete', async () => {
    const client = createClient({ rows: [{ id: FAMILY_ID }] });
    const response = await client.call(`/api/families/${FAMILY_ID}`, { method: 'DELETE' });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('delete'), false);
  });

  it('reports 404 for a household that is already gone', async () => {
    const client = createClient({ as: 'user-4', rows: [] });
    const response = await client.call(`/api/families/${FAMILY_ID}`, { method: 'DELETE' });

    assert.equal(response.status, 404);
  });
});

describe('POST /api/families/:id/members', () => {
  const body = { memberId: MEMBER_ID, relationship: 'spouse' };

  function client(options = {}) {
    const { perTable, ...rest } = options;
    return createClient({
      ...rest,
      // Merged, not replaced: a test overriding family_members must still get the
      // household row, or every case would 404 before reaching the insert.
      perTable: {
        families: { rows: [familyRow()] },
        family_members: { rows: [familyMemberRow({ relationship: 'spouse' })] },
        ...perTable,
      },
    });
  }

  it('adds a member and returns their place in the household', async () => {
    const test = client();
    const response = await test.call(`/api/families/${FAMILY_ID}/members`, {
      method: 'POST',
      body,
    });

    assert.equal(response.status, 201);
    const { data } = await response.json();
    assert.equal(data.relationship, 'spouse');
    assert.equal(data.fullName, 'Grace Mensah');
  });

  it('takes the branch from the household, never from the request', async () => {
    const test = client();
    await test.call(`/api/families/${FAMILY_ID}/members`, {
      method: 'POST',
      // A caller nominating a branch must have no effect: the composite foreign
      // keys are what stop a cross-branch link, and they key off this column.
      body: { ...body, branchId: '99999999-9999-4999-8999-999999999999' },
    });

    // `branchId` is not in the schema, so the request is rejected before any
    // insert — which is the stronger outcome.
    assert.equal(test.recorder.called('insert'), false);
  });

  it('writes the household’s own branch onto the membership row', async () => {
    const test = client();
    await test.call(`/api/families/${FAMILY_ID}/members`, { method: 'POST', body });

    const [row] = test.recorder.argsFor('insert');
    assert.equal(row.branch_id, BRANCH_MAIN);
    assert.equal(row.family_id, FAMILY_ID);
    assert.equal(row.member_id, MEMBER_ID);
    assert.equal(row.is_dependent, false, 'the documented default');
  });

  it('requires a relationship, and refuses one that is not a real value', async () => {
    const test = client();

    const missing = await test.call(`/api/families/${FAMILY_ID}/members`, {
      method: 'POST',
      body: { memberId: MEMBER_ID },
    });
    assert.equal(missing.status, 422);

    const invalid = await test.call(`/api/families/${FAMILY_ID}/members`, {
      method: 'POST',
      body: { memberId: MEMBER_ID, relationship: 'cousin-twice-removed' },
    });
    assert.equal(invalid.status, 422);
  });

  it('rejects a member id that is not a UUID', async () => {
    const test = client();
    const response = await test.call(`/api/families/${FAMILY_ID}/members`, {
      method: 'POST',
      body: { memberId: 'not-a-uuid', relationship: 'spouse' },
    });

    assert.equal(response.status, 422);
  });

  it('explains a second head rather than reporting a constraint', async () => {
    const test = client({
      perTable: {
        family_members: {
          rows: [],
          error: {
            code: '23505',
            message: 'duplicate key value violates unique constraint "family_members_one_head"',
          },
        },
      },
    });

    const response = await test.call(`/api/families/${FAMILY_ID}/members`, {
      method: 'POST',
      body: { memberId: MEMBER_ID, relationship: 'head' },
    });
    const text = await response.text();

    assert.equal(response.status, 409);
    assert.match(JSON.parse(text).error.details.fields.relationship, /already has a head/);
    assert.doesNotMatch(text, /family_members_one_head/);
  });

  it('explains that a member already belongs to another household', async () => {
    const test = client({
      perTable: {
        family_members: {
          rows: [],
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "family_members_one_household"',
          },
        },
      },
    });

    const response = await test.call(`/api/families/${FAMILY_ID}/members`, {
      method: 'POST',
      body,
    });

    assert.equal(response.status, 409);
    assert.match(
      (await response.json()).error.details.fields.memberId,
      /already belongs to another household/,
    );
  });

  it('explains a cross-branch member as a field error, not a 500', async () => {
    const test = client({
      perTable: {
        family_members: {
          rows: [],
          error: {
            code: '23503',
            message:
              'insert or update on table "family_members" violates foreign key constraint "family_members_member_fkey"',
          },
        },
      },
    });

    const response = await test.call(`/api/families/${FAMILY_ID}/members`, {
      method: 'POST',
      body,
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.memberId, /not in this branch/);
  });

  it('404s when the household is hidden, without attempting the insert', async () => {
    const test = client({ perTable: { families: { rows: [] } } });
    const response = await test.call(`/api/families/${FAMILY_ID}/members`, {
      method: 'POST',
      body,
    });

    assert.equal(response.status, 404);
    assert.equal(test.recorder.called('insert'), false);
  });

  it('refuses a caller without families.update', async () => {
    const test = createClient({ as: 'user-2', perTable: { families: { rows: [familyRow()] } } });
    const response = await test.call(`/api/families/${FAMILY_ID}/members`, {
      method: 'POST',
      body,
    });

    assert.equal(response.status, 403);
  });
});

describe('PATCH /api/families/:id/members/:memberId', () => {
  it('changes a relationship, matching on both ids', async () => {
    const client = createClient({ rows: [familyMemberRow({ relationship: 'father' })] });
    const response = await client.call(`/api/families/${FAMILY_ID}/members/${MEMBER_ID}`, {
      method: 'PATCH',
      body: { relationship: 'father' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.allArgsFor('eq'), [
      ['family_id', FAMILY_ID],
      ['member_id', MEMBER_ID],
    ]);
  });

  it('can mark someone a dependent without touching the relationship', async () => {
    const client = createClient({ rows: [familyMemberRow({ is_dependent: true })] });
    await client.call(`/api/families/${FAMILY_ID}/members/${MEMBER_ID}`, {
      method: 'PATCH',
      body: { isDependent: true },
    });

    assert.deepEqual(client.recorder.argsFor('update'), [{ is_dependent: true }]);
  });

  it('refuses an empty patch', async () => {
    const client = createClient({ rows: [familyMemberRow()] });
    const response = await client.call(`/api/families/${FAMILY_ID}/members/${MEMBER_ID}`, {
      method: 'PATCH',
      body: {},
    });

    assert.equal(response.status, 422);
  });

  it('reports 404 when that person is not in the household', async () => {
    const client = createClient({ rows: [] });
    const response = await client.call(`/api/families/${FAMILY_ID}/members/${MEMBER_ID}`, {
      method: 'PATCH',
      body: { relationship: 'son' },
    });

    assert.equal(response.status, 404);
    assert.match((await response.json()).error.message, /not in this household/);
  });
});

describe('DELETE /api/families/:id/members/:memberId', () => {
  it('removes the membership, leaving the member record alone', async () => {
    const client = createClient({ rows: [{ member_id: MEMBER_ID }] });
    const response = await client.call(`/api/families/${FAMILY_ID}/members/${MEMBER_ID}`, {
      method: 'DELETE',
    });

    assert.equal(response.status, 204);
    assert.deepEqual(client.recorder.tables(), ['family_members'], 'members is never touched');
  });

  it('reports 404 when the person was not in the household', async () => {
    const client = createClient({ rows: [] });
    const response = await client.call(`/api/families/${FAMILY_ID}/members/${MEMBER_ID}`, {
      method: 'DELETE',
    });

    assert.equal(response.status, 404);
  });
});

describe('escapeLikePattern', () => {
  it('escapes the characters ilike would otherwise treat as wildcards', () => {
    assert.equal(escapeLikePattern('100%'), '100\\%');
    assert.equal(escapeLikePattern('a_b'), 'a\\_b');
    assert.equal(escapeLikePattern('back\\slash'), 'back\\\\slash');
  });

  it('leaves ordinary text alone', () => {
    assert.equal(escapeLikePattern('The Mensah Family'), 'The Mensah Family');
  });

  it('escapes the backslash first, so an escape cannot be double-applied', () => {
    // '\%' must become '\\\%' — not '\\%', which would escape the backslash and
    // leave the wildcard live.
    assert.equal(escapeLikePattern('\\%'), '\\\\\\%');
  });
});
