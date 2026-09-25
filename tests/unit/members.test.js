/**
 * Member endpoints, end to end through the real router, guards, and validation.
 *
 * The Supabase client is a recorder (see members-fixtures.js), so these tests
 * assert two different things:
 *
 *   * behaviour the caller sees — status codes, permission refusals, validation
 *     messages, pagination metadata, field mapping
 *   * the query the service built — that the `deleted_at` filter is there, that
 *     search uses the `simple` configuration the index was built for, that the
 *     sort has a stable tiebreaker
 *
 * The second kind matters because a missing filter returns MORE rows rather than
 * an error. RLS would still contain the damage, but the list would be wrong.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createMembersService } from '../../src/services/members.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import {
  BRANCH_MAIN,
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import { createQueryRecorder, memberPayload, memberRow } from './members-fixtures.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });
const BRANCH = BRANCH_MAIN;

/**
 * A signed-in client whose data layer is a recorder.
 *
 * `as` names a fixture profile: 'user-1' is a secretary with members.view/create
 * in branch-main, 'user-2' an usher with only the directory permission.
 */
function createClient({ as = 'user-1', profiles = FIXTURES.profiles, ...recorderOptions } = {}) {
  const recorder = createQueryRecorder(recorderOptions);
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });
  const members = createMembersService({ getClient: recorder.getClient });

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(profiles),
    rateLimiter: createRateLimiter(),
    members,
  });

  const token = mintToken({ sub: as });
  const csrf = 'a'.repeat(64);

  async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const requestHeaders = {
      'sec-fetch-site': 'same-origin',
      cookie: `cma_at=${token}; cma_csrf=${csrf}`,
      'x-csrf-token': csrf,
      ...headers,
    };

    // A null value removes a default, for the tests that omit the CSRF header.
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

/** An unauthenticated client, for the "no session" cases. */
async function callAnonymous(path, options = {}) {
  const recorder = createQueryRecorder();
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });
  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    members: createMembersService({ getClient: recorder.getClient }),
  });

  return handleRequest(
    new Request(`http://localhost:3000${path}`, {
      headers: { 'sec-fetch-site': 'same-origin' },
      ...options,
    }),
    { router, sink: () => {} },
  );
}

/* -------------------------------------------------------------------------- */

describe('the member route table', () => {
  it('gives every route a permission — none is public', () => {
    const memberRoutes = buildRouter({
      cfg,
      provider: createFakeProvider({}).provider,
      loadIdentity: createFakeIdentityLoader({}),
      members: createMembersService({ getClient: createQueryRecorder().getClient }),
    })
      .list()
      .filter((route) => route.pattern.startsWith('/members'));

    // Seven member routes, plus GET /members/:id/attendance from the attendance
    // module, four /members/:id/emergency-contacts routes, four /members/:id/photo
    // routes, and three /members/:id/spiritual-gifts routes — all hang off a member.
    assert.equal(memberRoutes.length, 19);
    for (const route of memberRoutes) {
      assert.equal(route.isPublic, false, `${route.pattern} must not be public`);
      assert.ok(route.permission, `${route.pattern} must declare a permission`);
    }
  });

  it('registers the literal /members/directory before the /members/:id parameter', () => {
    const patterns = buildRouter({
      cfg,
      provider: createFakeProvider({}).provider,
      loadIdentity: createFakeIdentityLoader({}),
      members: createMembersService({ getClient: createQueryRecorder().getClient }),
    })
      .list()
      .map((route) => route.pattern);

    assert.ok(
      patterns.indexOf('/members/directory') < patterns.indexOf('/members/:id'),
      'otherwise "directory" would be read as a member id',
    );
  });
});

describe('GET /api/members — access', () => {
  it('refuses an anonymous caller', async () => {
    const response = await callAnonymous('/api/members');
    assert.equal(response.status, 401);
  });

  it('refuses a signed-in caller without members.view', async () => {
    const client = createClient({ as: 'user-2' }); // usher: directory only
    const response = await client.call('/api/members');

    assert.equal(response.status, 403);
    const { error } = await response.json();
    assert.equal(error.code, 'FORBIDDEN');
    assert.doesNotMatch(error.message, /members\.view/, 'the message must not name the permission');
  });

  it('admits a caller who holds it', async () => {
    const client = createClient({ rows: [memberRow()], count: 1 });
    const response = await client.call('/api/members');
    assert.equal(response.status, 200);
  });
});

describe('GET /api/members — the query it builds', () => {
  it('excludes soft-deleted rows', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/members');

    assert.deepEqual(client.recorder.argsFor('is'), ['deleted_at', null]);
  });

  it('asks for an exact count, so the page total is true rather than estimated', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/members');

    const [columns, options] = client.recorder.argsFor('select');
    assert.match(columns, /member_no/);
    assert.deepEqual(options, { count: 'exact' });
  });

  it('requests only list columns, not whole records', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/members');

    const [columns] = client.recorder.argsFor('select');
    assert.doesNotMatch(columns, /notes/, 'notes is free text about a person; not for a list');
    assert.doesNotMatch(columns, /address_line/);
    assert.doesNotMatch(columns, /date_of_birth/);
  });

  it('narrows by branch when asked', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call(`/api/members?branchId=${BRANCH}`);

    assert.deepEqual(client.recorder.argsFor('eq'), ['branch_id', BRANCH]);
  });

  it('does not filter by branch when none is given, leaving RLS to narrow it', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/members');

    assert.equal(client.recorder.called('eq'), false);
  });

  it('narrows by membership status, accepting repeated or comma-separated values', async () => {
    const repeated = createClient({ rows: [], count: 0 });
    await repeated.call('/api/members?status=active&status=new');
    assert.deepEqual(repeated.recorder.argsFor('in'), ['membership_status', ['active', 'new']]);

    const commaSeparated = createClient({ rows: [], count: 0 });
    await commaSeparated.call('/api/members?statuses=active,inactive');
    assert.deepEqual(commaSeparated.recorder.argsFor('in'), [
      'membership_status',
      ['active', 'inactive'],
    ]);
  });

  it('rejects an unrecognised status rather than quietly showing everything', async () => {
    const client = createClient({ rows: [], count: 0 });
    const response = await client.call('/api/members?status=vip');

    assert.equal(response.status, 422);
    const { error } = await response.json();
    assert.match(error.details.fields.status, /Use one of/);
  });

  it('searches with the simple configuration the GIN index was built for', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/members?search=Mensah');

    assert.deepEqual(client.recorder.argsFor('textSearch'), [
      'search_vector',
      'Mensah',
      { type: 'plain', config: 'simple' },
    ]);
  });

  it('does not search on an empty or whitespace query', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/members?search=%20%20');

    assert.equal(client.recorder.called('textSearch'), false);
  });

  it('sorts by surname by default, with id as a stable tiebreaker', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/members');

    assert.deepEqual(client.recorder.allArgsFor('order'), [
      ['last_name', { ascending: true }],
      ['id', { ascending: true }],
    ]);
  });

  it('honours a descending sort on an allowed column', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/members?sort=-joined');

    assert.deepEqual(client.recorder.allArgsFor('order')[0], ['date_joined', { ascending: false }]);
  });

  it('ignores a sort key that is not on the allow-list, rather than passing it through', async () => {
    const client = createClient({ rows: [], count: 0 });
    // A column name reaching the query builder unchecked would leak the table
    // shape through error messages.
    await client.call('/api/members?sort=notes');

    assert.deepEqual(client.recorder.allArgsFor('order')[0], ['last_name', { ascending: true }]);
  });
});

describe('GET /api/members — pagination', () => {
  it('defaults to the first 25', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/members');

    assert.deepEqual(client.recorder.argsFor('range'), [0, 24]);
  });

  it('computes the range for a later page', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/members?page=3&pageSize=10');

    assert.deepEqual(client.recorder.argsFor('range'), [20, 29]);
  });

  it('caps the page size server-side, so the whole roll cannot be pulled at once', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/members?pageSize=100000');

    assert.deepEqual(client.recorder.argsFor('range'), [0, 99]);
  });

  it('falls back to page 1 for nonsense, rather than erroring on a stale bookmark', async () => {
    for (const query of ['page=0', 'page=-4', 'page=abc', 'pageSize=0']) {
      const client = createClient({ rows: [], count: 0 });
      await client.call(`/api/members?${query}`);
      const [from] = client.recorder.argsFor('range');
      assert.equal(from, 0, `?${query} should land on the first page`);
    }
  });

  it('returns metadata a pager can be built from', async () => {
    const client = createClient({ rows: [memberRow()], count: 57 });
    const response = await client.call('/api/members?page=2&pageSize=10');

    const { meta } = await response.json();
    assert.deepEqual(meta, {
      page: 2,
      pageSize: 10,
      total: 57,
      pageCount: 6,
      hasPrevious: true,
      hasNext: true,
      sort: 'name',
      ascending: true,
    });
  });

  it('reports no next page on the last one', async () => {
    const client = createClient({ rows: [memberRow()], count: 20 });
    const response = await client.call('/api/members?page=2&pageSize=10');

    const { meta } = await response.json();
    assert.equal(meta.hasNext, false);
    assert.equal(meta.hasPrevious, true);
  });
});

describe('GET /api/members — removed members', () => {
  it('lists them for a caller who can restore them', async () => {
    const client = createClient({ rows: [], count: 0, as: 'user-4' });
    // user-4 is defined below with members.view + members.delete.
    const response = await client.call('/api/members?deleted=1');

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('not'), ['deleted_at', 'is', null]);
  });

  it('refuses a caller who cannot', async () => {
    const client = createClient(); // secretary: no members.delete
    const response = await client.call('/api/members?deleted=1');

    assert.equal(response.status, 403);
  });
});

describe('POST /api/members', () => {
  it('creates a member and returns it with its generated number', async () => {
    const client = createClient({ rows: [memberRow()] });
    const response = await client.call('/api/members', {
      method: 'POST',
      body: memberPayload({ email: 'kofi@example.com' }),
    });

    assert.equal(response.status, 201);
    assert.equal(response.headers.get('location'), `/api/members/${memberRow().id}`);

    const { data } = await response.json();
    assert.equal(data.memberNo, 'MAIN-000101');
    assert.equal(data.fullName, 'Grace Mensah');
  });

  it('defaults to the caller’s branch, so a single-branch church needs no picker', async () => {
    const client = createClient({ rows: [memberRow()] });
    await client.call('/api/members', { method: 'POST', body: memberPayload() });

    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.branch_id, BRANCH);
  });

  it('maps payload fields to columns, and omits the ones not supplied', async () => {
    const client = createClient({ rows: [memberRow()] });
    await client.call('/api/members', {
      method: 'POST',
      body: memberPayload({ firstName: 'Kofi', lastName: 'Annan', dateOfBirth: '1988-03-02' }),
    });

    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.first_name, 'Kofi');
    assert.equal(row.last_name, 'Annan');
    assert.equal(row.date_of_birth, '1988-03-02');
    assert.equal(row.membership_status, 'visitor', 'the documented default');
    assert.equal(row.is_baptized, false);
    assert.ok(!('occupation' in row), 'a field not supplied must not be written as null');
  });

  it('refuses a caller who cannot create in the target branch', async () => {
    const client = createClient({ rows: [memberRow()] });
    const response = await client.call('/api/members', {
      method: 'POST',
      body: memberPayload({ branchId: '99999999-9999-4999-8999-999999999999' }),
    });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('insert'), false, 'nothing may reach the database');
  });

  it('refuses a caller without members.create at all', async () => {
    const client = createClient({ as: 'user-2', rows: [memberRow()] });
    const response = await client.call('/api/members', {
      method: 'POST',
      body: memberPayload(),
    });

    assert.equal(response.status, 403);
  });

  it('requires a first and last name', async () => {
    const client = createClient();
    const response = await client.call('/api/members', {
      method: 'POST',
      body: { firstName: '', lastName: '' },
    });

    assert.equal(response.status, 422);
    const { error } = await response.json();
    assert.ok(error.details.fields.firstName);
    assert.ok(error.details.fields.lastName);
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    const client = createClient();
    const response = await client.call('/api/members', {
      method: 'POST',
      body: memberPayload({ isSuperAdmin: true, member_no: 'MAIN-000001' }),
    });

    assert.equal(response.status, 422);
  });

  it('refuses to let a caller set the member number, which the database assigns', async () => {
    const client = createClient();
    const response = await client.call('/api/members', {
      method: 'POST',
      body: memberPayload({ memberNo: 'MAIN-000001' }),
    });

    assert.equal(response.status, 422);
  });

  it('rejects a date of birth in the future', async () => {
    const client = createClient();
    const response = await client.call('/api/members', {
      method: 'POST',
      body: memberPayload({ dateOfBirth: '2999-01-01' }),
    });

    assert.equal(response.status, 422);
    assert.match(
      (await response.json()).error.details.fields.dateOfBirth,
      /cannot be in the future/,
    );
  });

  it('rejects a date that does not exist', async () => {
    const client = createClient();
    const response = await client.call('/api/members', {
      method: 'POST',
      body: memberPayload({ dateOfBirth: '2026-02-31' }),
    });

    assert.equal(response.status, 422);
  });

  it('rejects a baptism date without a baptism, mirroring the CHECK constraint', async () => {
    const client = createClient();
    const response = await client.call('/api/members', {
      method: 'POST',
      body: memberPayload({ isBaptized: false, baptismDate: '2020-01-01' }),
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.baptismDate, /baptised/);
  });

  it('rejects a baptism before birth', async () => {
    const client = createClient();
    const response = await client.call('/api/members', {
      method: 'POST',
      body: memberPayload({
        dateOfBirth: '2000-01-01',
        isBaptized: true,
        baptismDate: '1999-01-01',
      }),
    });

    assert.equal(response.status, 422);
  });

  it('normalises an email and treats a cleared field as absent', async () => {
    const client = createClient({ rows: [memberRow()] });
    await client.call('/api/members', {
      method: 'POST',
      body: memberPayload({ email: '  Kofi@Example.COM ', occupation: '' }),
    });

    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.email, 'kofi@example.com');
    assert.equal(row.occupation, null, 'a cleared field is null, not an empty string');
  });

  it('turns a duplicate email into a 409 naming the field, without naming the constraint', async () => {
    const client = createClient({
      rows: [],
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "members_branch_email_key"',
      },
    });

    const response = await client.call('/api/members', {
      method: 'POST',
      body: memberPayload({ email: 'taken@example.com' }),
    });

    assert.equal(response.status, 409);
    const body = await response.text();
    assert.match(JSON.parse(body).error.details.fields.email, /already uses that email/);
    assert.doesNotMatch(body, /members_branch_email_key/, 'the constraint name reveals the schema');
    assert.doesNotMatch(body, /duplicate key value/);
  });

  it('turns an RLS refusal into a 403, not a 500', async () => {
    const client = createClient({
      rows: [],
      error: {
        code: '42501',
        message: 'new row violates row-level security policy for table "members"',
      },
    });

    const response = await client.call('/api/members', { method: 'POST', body: memberPayload() });
    assert.equal(response.status, 403);
  });

  it('says nothing about the database when an error is unrecognised', async () => {
    const client = createClient({
      rows: [],
      error: { code: 'XX000', message: 'connection to server at "db.abc.supabase.co" failed' },
    });

    const response = await client.call('/api/members', { method: 'POST', body: memberPayload() });
    const body = await response.text();

    assert.equal(response.status, 500);
    assert.doesNotMatch(body, /supabase\.co/);
    assert.doesNotMatch(body, /connection to server/);
    assert.match(JSON.parse(body).error.message, /went wrong/);
  });
});

describe('GET /api/members/:id', () => {
  it('returns the full record', async () => {
    const client = createClient({ rows: [memberRow()] });
    const response = await client.call('/api/members/11111111-1111-4111-8111-111111111111');

    assert.equal(response.status, 200);
    const { data } = await response.json();

    assert.equal(data.notes, null);
    assert.equal(data.addressLine, '12 Independence Avenue');
    assert.equal(data.hasLogin, false, 'user_id is reported as a boolean, never as an id');
  });

  it('never exposes the linked auth user id', async () => {
    const client = createClient({ rows: [memberRow({ user_id: 'auth-user-42' })] });
    const response = await client.call('/api/members/11111111-1111-4111-8111-111111111111');

    const body = await response.text();
    assert.doesNotMatch(body, /auth-user-42/);
    assert.equal(JSON.parse(body).data.hasLogin, true);
  });

  it('answers 404 for a row RLS hides, so a 403 cannot confirm the id is real', async () => {
    const client = createClient({ rows: [] });
    const response = await client.call('/api/members/11111111-1111-4111-8111-111111111111');

    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  });
});

describe('PATCH /api/members/:id', () => {
  it('applies only the supplied fields', async () => {
    const client = createClient({ rows: [memberRow({ city: 'Kumasi' })] });
    const response = await client.call('/api/members/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: { city: 'Kumasi' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [{ city: 'Kumasi' }]);
  });

  it('does not reset the fields it was not given — the bug this test was written for', async () => {
    const client = createClient({ rows: [memberRow()] });
    await client.call('/api/members/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: { city: 'Kumasi' },
    });

    const [patch] = client.recorder.argsFor('update');

    // zod's .partial() does NOT strip a .default(), so an earlier version of the
    // update schema produced membership_status: 'visitor' and is_baptized: false
    // on every edit — quietly demoting an active member on a change of address.
    assert.deepEqual(Object.keys(patch), ['city']);
    assert.ok(!('membership_status' in patch));
    assert.ok(!('is_baptized' in patch));
  });

  it('refuses an empty patch instead of issuing a pointless write', async () => {
    const client = createClient({ rows: [memberRow()] });
    const response = await client.call('/api/members/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: {},
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('update'), false);
  });

  it('will not move a member between branches through the edit form', async () => {
    const client = createClient({ rows: [memberRow()] });
    const response = await client.call('/api/members/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: { branchId: '99999999-9999-4999-8999-999999999999' },
    });

    // branchId is not in the update schema at all, so .strict() rejects it. A
    // database trigger refuses it independently.
    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('update'), false);
  });

  it('never updates a soft-deleted row', async () => {
    const client = createClient({ rows: [memberRow()] });
    await client.call('/api/members/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: { city: 'Kumasi' },
    });

    assert.deepEqual(client.recorder.argsFor('is'), ['deleted_at', null]);
  });

  it('requires the CSRF token', async () => {
    const client = createClient({ rows: [memberRow()] });
    const response = await client.call('/api/members/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: { city: 'Kumasi' },
      headers: { 'x-csrf-token': null },
    });

    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'CSRF_FAILED');
  });

  it('refuses a caller without members.update', async () => {
    const client = createClient({ as: 'user-2', rows: [memberRow()] });
    const response = await client.call('/api/members/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: { city: 'Kumasi' },
    });

    assert.equal(response.status, 403);
  });

  it('surfaces a trigger refusal as a 409 carrying the message written for a user', async () => {
    const client = createClient({
      rows: [],
      error: { code: '23001', message: 'A member number cannot be changed once assigned' },
    });

    const response = await client.call('/api/members/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      body: { city: 'Kumasi' },
    });

    assert.equal(response.status, 409);
    assert.match((await response.json()).error.message, /cannot be changed once assigned/);
  });
});

describe('DELETE /api/members/:id', () => {
  it('soft deletes, setting deleted_at rather than removing the row', async () => {
    const client = createClient({ rows: [{ id: memberRow().id }], as: 'user-4' });
    const response = await client.call(`/api/members/${memberRow().id}`, { method: 'DELETE' });

    assert.equal(response.status, 204);

    const [patch] = client.recorder.argsFor('update');
    assert.ok(patch.deleted_at, 'deleted_at must be set');
    assert.deepEqual(Object.keys(patch), ['deleted_at'], 'and nothing else touched');
  });

  it('refuses a caller without members.delete', async () => {
    const client = createClient({ rows: [{ id: memberRow().id }] });
    const response = await client.call(`/api/members/${memberRow().id}`, { method: 'DELETE' });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('update'), false);
  });

  it('is idempotent in effect: a second delete reports 404 rather than succeeding twice', async () => {
    const client = createClient({ rows: [], as: 'user-4' });
    const response = await client.call(`/api/members/${memberRow().id}`, { method: 'DELETE' });

    assert.equal(response.status, 404);
  });
});

describe('POST /api/members/:id/restore', () => {
  it('clears deleted_at and returns the member', async () => {
    const client = createClient({ rows: [memberRow()], as: 'user-4' });
    const response = await client.call(`/api/members/${memberRow().id}/restore`, {
      method: 'POST',
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [{ deleted_at: null }]);
    assert.deepEqual(client.recorder.argsFor('not'), ['deleted_at', 'is', null]);
  });

  it('refuses a caller without members.delete', async () => {
    const client = createClient({ rows: [memberRow()] });
    const response = await client.call(`/api/members/${memberRow().id}/restore`, {
      method: 'POST',
    });

    assert.equal(response.status, 403);
  });
});

describe('GET /api/members/directory', () => {
  it('is available to an usher, who has no access to the members table', async () => {
    const client = createClient({
      as: 'user-2',
      rows: [
        {
          id: 'm1',
          member_no: 'MAIN-000101',
          full_name: 'Grace Mensah',
          photo_path: null,
          membership_status: 'active',
        },
      ],
    });

    const response = await client.call(`/api/members/directory?branchId=${BRANCH}`);
    assert.equal(response.status, 200);

    const { data } = await response.json();
    assert.deepEqual(Object.keys(data[0]).sort(), [
      'fullName',
      'id',
      'memberNo',
      'membershipStatus',
      'photoPath',
    ]);
  });

  it('goes through the database function, which enforces the permission itself', async () => {
    const client = createClient({ as: 'user-2', rows: [] });
    await client.call(`/api/members/directory?branchId=${BRANCH}&search=Mensah`);

    assert.deepEqual(client.recorder.rpcCalls, [
      {
        name: 'search_member_directory',
        params: { p_branch_id: BRANCH, p_query: 'Mensah', p_limit: 20, p_offset: 0 },
      },
    ]);
  });

  it('never returns an address, a date of birth, or a phone number', async () => {
    const client = createClient({
      as: 'user-2',
      rows: [
        {
          id: 'm1',
          member_no: 'MAIN-000101',
          full_name: 'Grace Mensah',
          photo_path: null,
          membership_status: 'active',
          // Even if the function were widened, the view must not forward these.
          address_line: '12 Independence Avenue',
          date_of_birth: '1990-04-12',
          phone: '+233201234567',
        },
      ],
    });

    const body = await (await client.call(`/api/members/directory?branchId=${BRANCH}`)).text();

    assert.doesNotMatch(body, /Independence/);
    assert.doesNotMatch(body, /1990-04-12/);
    assert.doesNotMatch(body, /233201234567/);
  });

  it('falls back to the caller’s default branch', async () => {
    const client = createClient({ as: 'user-2', rows: [] });
    await client.call('/api/members/directory');

    assert.equal(client.recorder.rpcCalls[0].params.p_branch_id, BRANCH);
  });
});
