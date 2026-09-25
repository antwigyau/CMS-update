/**
 * Ministry endpoints, with the leadership model as the main subject.
 *
 * The question these tests exist to answer: can a ministry leader manage their
 * own ministry through the API, and nothing else? That is the one place where
 * authority is computed rather than granted, and it was also where the first
 * draft of the permission model went wrong (ADR-020) — so it is tested from both
 * directions, positive and negative.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import {
  createMinistriesService,
  escapeLikePattern,
} from '../../src/services/ministries.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import {
  BRANCH_MAIN,
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import {
  MEMBER_ID,
  MINISTRY_ID,
  OTHER_MINISTRY_ID,
  ministryListRow,
  ministryMemberRow,
  ministryPayload,
  ministryRow,
} from './ministries-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });

/** 'user-6' leads the choir; 'user-7' is the branch ministry administrator. */
function createClient({ as = 'user-7', ...recorderOptions } = {}) {
  const recorder = createQueryRecorder(recorderOptions);
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    ministries: createMinistriesService({ getClient: recorder.getClient }),
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

  return { call, recorder };
}

/** A recorder whose ministry reads return the choir. */
const withChoir = (extra = {}) => ({
  perTable: {
    ministries: { rows: [ministryRow()] },
    ministry_members: { rows: [ministryMemberRow()] },
    ...extra,
  },
});

/* -------------------------------------------------------------------------- */

describe('the ministry route table', () => {
  const routes = buildRouter({
    cfg,
    provider: createFakeProvider({}).provider,
    loadIdentity: createFakeIdentityLoader({}),
    ministries: createMinistriesService({ getClient: createQueryRecorder().getClient }),
  })
    .list()
    .filter((route) => route.pattern.startsWith('/ministries'));

  it('registers seven routes, none of them public', () => {
    assert.equal(routes.length, 7);
    for (const route of routes) {
      assert.equal(route.isPublic, false);
      assert.ok(route.permission);
    }
  });

  it('admits a leader only on the three routes a leader should reach', () => {
    const leadershipRoutes = routes
      .filter((route) => route.guard === 'permissionOrLeadership')
      .map((route) => `${route.method} ${route.pattern}`)
      .sort();

    assert.deepEqual(leadershipRoutes, [
      'PATCH /ministries/:id',
      'PATCH /ministries/:id/members/:memberId',
      'POST /ministries/:id/members',
    ]);
  });

  it('does not admit a leader to create or delete a ministry', () => {
    for (const pattern of ['POST /ministries', 'DELETE /ministries/:id']) {
      const route = routes.find((item) => `${item.method} ${item.pattern}` === pattern);
      assert.equal(route.guard, 'permission', `${pattern} must not accept leadership`);
    }
  });
});

describe('GET /api/ministries', () => {
  it('refuses a caller without ministries.view', async () => {
    const client = createClient({ as: 'user-2', rows: [] });
    assert.equal((await client.call('/api/ministries')).status, 403);
  });

  it('returns ministries with a member count and a leadership flag', async () => {
    const client = createClient({ as: 'user-6', rows: [ministryListRow()], count: 1 });
    const response = await client.call('/api/ministries');

    assert.equal(response.status, 200);
    const { data } = await response.json();

    assert.equal(data[0].name, 'Choir');
    assert.equal(data[0].memberCount, 12);
    assert.equal(data[0].youLead, true, 'user-6 leads the choir');
    assert.equal(data[0].meetingTime, '18:30', 'seconds are trimmed for display');
  });

  it('reports youLead false for someone who leads nothing', async () => {
    const client = createClient({ rows: [ministryListRow()], count: 1 });
    const { data } = await (await client.call('/api/ministries')).json();

    assert.equal(data[0].youLead, false);
  });

  it('filters by status, and rejects a status that is not real', async () => {
    const filtered = createClient({ rows: [], count: 0 });
    await filtered.call('/api/ministries?status=inactive');
    assert.deepEqual(filtered.recorder.argsFor('eq'), ['status', 'inactive']);

    const bad = createClient({ rows: [], count: 0 });
    const response = await bad.call('/api/ministries?status=dormant');
    assert.equal(response.status, 422);
  });

  it('searches by name with wildcards escaped', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/ministries?search=%25choir');

    assert.deepEqual(client.recorder.argsFor('ilike'), ['name', '%\\%choir%']);
  });

  it('sorts with a stable tiebreaker and caps the page size', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/ministries?pageSize=9999');

    assert.deepEqual(client.recorder.allArgsFor('order'), [
      ['name', { ascending: true }],
      ['id', { ascending: true }],
    ]);
    assert.deepEqual(client.recorder.argsFor('range'), [0, 99]);
  });
});

describe('GET /api/ministries/:id', () => {
  it('returns the ministry with its current members, leader singled out', async () => {
    const client = createClient({
      as: 'user-6',
      perTable: {
        ministries: { rows: [ministryRow()] },
        ministry_members: {
          rows: [
            ministryMemberRow(),
            ministryMemberRow({
              id: 'mm-leader',
              member_id: 'member-leader',
              role_in_ministry: 'leader',
              members: { full_name: 'Esi Boateng', member_no: 'MAIN-000200' },
            }),
            ministryMemberRow({
              id: 'mm-assistant',
              member_id: 'member-assistant',
              role_in_ministry: 'assistant_leader',
              members: { full_name: 'Yaw Darko', member_no: 'MAIN-000201' },
            }),
          ],
        },
      },
    });

    const response = await client.call(`/api/ministries/${MINISTRY_ID}`);
    assert.equal(response.status, 200);

    const { data } = await response.json();
    assert.equal(data.name, 'Choir');
    assert.equal(data.memberCount, 3);
    assert.equal(data.leader.fullName, 'Esi Boateng');
    assert.deepEqual(
      data.assistantLeaders.map((member) => member.fullName),
      ['Yaw Darko'],
    );
    assert.equal(data.youLead, true);
  });

  it('reports no leader rather than inventing one', async () => {
    const client = createClient({
      perTable: {
        ministries: { rows: [ministryRow()] },
        ministry_members: { rows: [ministryMemberRow()] },
      },
    });

    const { data } = await (await client.call(`/api/ministries/${MINISTRY_ID}`)).json();
    assert.equal(data.leader, null);
    assert.deepEqual(data.assistantLeaders, []);
  });

  it('shows current members only, unless former ones are asked for', async () => {
    const current = createClient(withChoir());
    await current.call(`/api/ministries/${MINISTRY_ID}`);
    assert.deepEqual(current.recorder.argsFor('is'), ['left_on', null]);

    const withFormer = createClient(withChoir());
    await withFormer.call(`/api/ministries/${MINISTRY_ID}?former=1`);
    assert.equal(withFormer.recorder.called('is'), false, 'the filter is dropped');
  });

  it('excludes someone who has left from the member count', async () => {
    const client = createClient({
      perTable: {
        ministries: { rows: [ministryRow()] },
        ministry_members: {
          rows: [
            ministryMemberRow(),
            ministryMemberRow({ id: 'mm-gone', member_id: 'member-gone', left_on: '2026-01-31' }),
          ],
        },
      },
    });

    const { data } = await (await client.call(`/api/ministries/${MINISTRY_ID}?former=1`)).json();
    assert.equal(data.members.length, 2, 'both are returned');
    assert.equal(data.memberCount, 1, 'but only one is counted as current');
    assert.equal(data.members.find((member) => member.leftOn)?.isActive, false);
  });

  it('404s a ministry the caller cannot see, without querying members', async () => {
    const client = createClient({ perTable: { ministries: { rows: [] } } });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}`);

    assert.equal(response.status, 404);
    assert.deepEqual(client.recorder.tables(), ['ministries']);
  });
});

describe('POST /api/ministries', () => {
  it('creates a ministry with the documented defaults', async () => {
    const client = createClient({ rows: [ministryRow()] });
    const response = await client.call('/api/ministries', {
      method: 'POST',
      body: ministryPayload(),
    });

    assert.equal(response.status, 201);
    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.branch_id, BRANCH_MAIN);
    assert.equal(row.status, 'active');
  });

  it('upper-cases a short code, so CHOIR and choir are the same code', async () => {
    const client = createClient({ rows: [ministryRow()] });
    await client.call('/api/ministries', {
      method: 'POST',
      body: ministryPayload({ code: 'choir' }),
    });

    assert.equal(client.recorder.argsFor('insert')[0].code, 'CHOIR');
  });

  it('accepts a weekday number and a time', async () => {
    const client = createClient({ rows: [ministryRow()] });
    await client.call('/api/ministries', {
      method: 'POST',
      body: ministryPayload({ meetingDay: 4, meetingTime: '18:30' }),
    });

    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.meeting_day, 4);
    assert.equal(row.meeting_time, '18:30');
  });

  it('rejects a weekday outside 1–7', async () => {
    const client = createClient();
    for (const meetingDay of [0, 8, -1]) {
      const response = await client.call('/api/ministries', {
        method: 'POST',
        body: ministryPayload({ meetingDay }),
      });
      assert.equal(response.status, 422, `day ${meetingDay}`);
    }
  });

  it('rejects a malformed time', async () => {
    const client = createClient();
    for (const meetingTime of ['6pm', '25:00', '18:70']) {
      const response = await client.call('/api/ministries', {
        method: 'POST',
        body: ministryPayload({ meetingTime }),
      });
      assert.equal(response.status, 422, meetingTime);
    }
  });

  it('refuses a ministry leader — you cannot lead one that does not exist yet', async () => {
    const client = createClient({ as: 'user-6', rows: [ministryRow()] });
    const response = await client.call('/api/ministries', {
      method: 'POST',
      body: ministryPayload(),
    });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('explains a duplicate name without naming the constraint', async () => {
    const client = createClient({
      rows: [],
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "ministries_branch_name_key"',
      },
    });

    const response = await client.call('/api/ministries', {
      method: 'POST',
      body: ministryPayload(),
    });
    const text = await response.text();

    assert.equal(response.status, 409);
    assert.match(JSON.parse(text).error.details.fields.name, /already exists in this branch/);
    assert.doesNotMatch(text, /ministries_branch_name_key/);
  });
});

/* -------------------------------------------------------------------------- */
/* The leadership model                                                       */
/* -------------------------------------------------------------------------- */

describe('PATCH /api/ministries/:id — leadership', () => {
  const body = { meetingLocation: 'Upper room' };

  it('lets a leader edit the ministry they lead', async () => {
    const client = createClient({ as: 'user-6', ...withChoir() });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}`, {
      method: 'PATCH',
      body,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [{ meeting_location: 'Upper room' }]);
  });

  it('refuses that same leader on a ministry they do not lead', async () => {
    const client = createClient({
      as: 'user-6',
      perTable: {
        // The ministry exists and is visible; it is simply not theirs.
        ministries: { rows: [ministryRow({ id: OTHER_MINISTRY_ID, name: 'Ushering' })] },
      },
    });

    const response = await client.call(`/api/ministries/${OTHER_MINISTRY_ID}`, {
      method: 'PATCH',
      body,
    });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('update'), false, 'nothing may reach the database');
  });

  it('lets the branch administrator edit any ministry', async () => {
    const client = createClient({ ...withChoir() });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}`, {
      method: 'PATCH',
      body,
    });

    assert.equal(response.status, 200);
  });

  it('refuses someone who neither leads nor holds the permission, at the guard', async () => {
    const client = createClient({ as: 'user-1', ...withChoir() });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}`, {
      method: 'PATCH',
      body,
    });

    assert.equal(response.status, 403);
    // Refused before the ministry was even read.
    assert.deepEqual(client.recorder.tables(), []);
  });

  it('refuses an empty patch', async () => {
    const client = createClient({ ...withChoir() });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}`, {
      method: 'PATCH',
      body: {},
    });

    assert.equal(response.status, 422);
  });

  it('will not move a ministry between branches', async () => {
    const client = createClient({ ...withChoir() });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}`, {
      method: 'PATCH',
      body: { branchId: BRANCH_MAIN },
    });

    assert.equal(response.status, 422);
  });

  it('requires the CSRF token', async () => {
    const client = createClient({ as: 'user-6', ...withChoir() });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}`, {
      method: 'PATCH',
      body,
      headers: { 'x-csrf-token': null },
    });

    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'CSRF_FAILED');
  });
});

describe('DELETE /api/ministries/:id', () => {
  it('refuses a leader — deleting removes the ministry’s history from everyone', async () => {
    const client = createClient({ as: 'user-6', ...withChoir() });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}`, { method: 'DELETE' });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('delete'), false);
  });

  it('allows the branch administrator', async () => {
    const client = createClient({
      perTable: { ministries: { rows: [ministryRow()] } },
    });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}`, { method: 'DELETE' });

    assert.equal(response.status, 204);
    assert.ok(client.recorder.called('delete'));
  });
});

describe('POST /api/ministries/:id/members', () => {
  const body = { memberId: MEMBER_ID, roleInMinistry: 'member' };

  it('lets a leader add an ordinary member to their own ministry', async () => {
    const client = createClient({ as: 'user-6', ...withChoir() });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}/members`, {
      method: 'POST',
      body,
    });

    assert.equal(response.status, 201);

    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.ministry_id, MINISTRY_ID);
    assert.equal(row.branch_id, BRANCH_MAIN, 'the branch comes from the ministry row');
    assert.equal(row.role_in_ministry, 'member');
  });

  it('refuses a leader appointing another leader or assistant', async () => {
    for (const roleInMinistry of ['leader', 'assistant_leader']) {
      const client = createClient({ as: 'user-6', ...withChoir() });
      const response = await client.call(`/api/ministries/${MINISTRY_ID}/members`, {
        method: 'POST',
        body: { memberId: MEMBER_ID, roleInMinistry },
      });

      // Otherwise a leader could expand the set of people who can edit their
      // ministry, or entrench themselves. It needs the branch permission.
      assert.equal(response.status, 403, roleInMinistry);
      assert.equal(client.recorder.called('insert'), false);
    }
  });

  it('lets the branch administrator appoint a leader', async () => {
    const client = createClient({ ...withChoir() });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}/members`, {
      method: 'POST',
      body: { memberId: MEMBER_ID, roleInMinistry: 'leader' },
    });

    assert.equal(response.status, 201);
  });

  it('refuses a leader adding to a ministry they do not lead', async () => {
    const client = createClient({
      as: 'user-6',
      perTable: { ministries: { rows: [ministryRow({ id: OTHER_MINISTRY_ID })] } },
    });

    const response = await client.call(`/api/ministries/${OTHER_MINISTRY_ID}/members`, {
      method: 'POST',
      body,
    });

    assert.equal(response.status, 403);
  });

  it('defaults the role to member', async () => {
    const client = createClient({ ...withChoir() });
    await client.call(`/api/ministries/${MINISTRY_ID}/members`, {
      method: 'POST',
      body: { memberId: MEMBER_ID },
    });

    assert.equal(client.recorder.argsFor('insert')[0].role_in_ministry, 'member');
  });

  it('explains a second leader rather than reporting a constraint', async () => {
    const client = createClient({
      perTable: {
        ministries: { rows: [ministryRow()] },
        ministry_members: {
          rows: [],
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "ministry_members_one_active_leader"',
          },
        },
      },
    });

    const response = await client.call(`/api/ministries/${MINISTRY_ID}/members`, {
      method: 'POST',
      body: { memberId: MEMBER_ID, roleInMinistry: 'leader' },
    });
    const text = await response.text();

    assert.equal(response.status, 409);
    assert.match(JSON.parse(text).error.details.fields.roleInMinistry, /already has a leader/);
    assert.doesNotMatch(text, /ministry_members_one_active_leader/);
  });

  it('explains a member who is already in the ministry', async () => {
    const client = createClient({
      perTable: {
        ministries: { rows: [ministryRow()] },
        ministry_members: {
          rows: [],
          error: {
            code: '23505',
            message: 'duplicate key value violates unique constraint "ministry_members_active_key"',
          },
        },
      },
    });

    const response = await client.call(`/api/ministries/${MINISTRY_ID}/members`, {
      method: 'POST',
      body,
    });

    assert.equal(response.status, 409);
    assert.match((await response.json()).error.details.fields.memberId, /already in this ministry/);
  });

  it('explains a cross-branch member as a field error', async () => {
    const client = createClient({
      perTable: {
        ministries: { rows: [ministryRow()] },
        ministry_members: {
          rows: [],
          error: {
            code: '23503',
            message:
              'insert or update on table "ministry_members" violates foreign key constraint "ministry_members_member_fkey"',
          },
        },
      },
    });

    const response = await client.call(`/api/ministries/${MINISTRY_ID}/members`, {
      method: 'POST',
      body,
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.memberId, /not in this branch/);
  });
});

describe('PATCH /api/ministries/:id/members/:memberId', () => {
  it('lets a leader end a membership by setting the date left', async () => {
    const client = createClient({
      as: 'user-6',
      perTable: {
        ministries: { rows: [ministryRow()] },
        ministry_members: { rows: [ministryMemberRow({ left_on: '2026-08-31' })] },
      },
    });

    const response = await client.call(`/api/ministries/${MINISTRY_ID}/members/${MEMBER_ID}`, {
      method: 'PATCH',
      body: { leftOn: '2026-08-31' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [{ left_on: '2026-08-31' }]);

    const { data } = await response.json();
    assert.equal(data.isActive, false);
  });

  it('matches the active row only, so a repeat membership is unambiguous', async () => {
    const client = createClient({ as: 'user-6', ...withChoir() });
    await client.call(`/api/ministries/${MINISTRY_ID}/members/${MEMBER_ID}`, {
      method: 'PATCH',
      body: { leftOn: '2026-08-31' },
    });

    assert.deepEqual(client.recorder.allArgsFor('eq').slice(-2), [
      ['ministry_id', MINISTRY_ID],
      ['member_id', MEMBER_ID],
    ]);
    assert.deepEqual(client.recorder.argsFor('is'), ['left_on', null]);
  });

  it('refuses a leader promoting someone into a leadership role', async () => {
    const client = createClient({ as: 'user-6', ...withChoir() });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}/members/${MEMBER_ID}`, {
      method: 'PATCH',
      body: { roleInMinistry: 'assistant_leader' },
    });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('update'), false);
  });

  it('lets a leader change someone back to an ordinary member', async () => {
    const client = createClient({ as: 'user-6', ...withChoir() });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}/members/${MEMBER_ID}`, {
      method: 'PATCH',
      body: { roleInMinistry: 'member' },
    });

    assert.equal(response.status, 200);
  });

  it('lets a leader reinstate someone by clearing the date left', async () => {
    const client = createClient({ as: 'user-6', ...withChoir() });
    await client.call(`/api/ministries/${MINISTRY_ID}/members/${MEMBER_ID}`, {
      method: 'PATCH',
      body: { leftOn: null },
    });

    assert.deepEqual(client.recorder.argsFor('update'), [{ left_on: null }]);
  });

  it('reports 404 when the person is not currently in the ministry', async () => {
    const client = createClient({
      perTable: {
        ministries: { rows: [ministryRow()] },
        ministry_members: { rows: [] },
      },
    });

    const response = await client.call(`/api/ministries/${MINISTRY_ID}/members/${MEMBER_ID}`, {
      method: 'PATCH',
      body: { roleInMinistry: 'member' },
    });

    assert.equal(response.status, 404);
    assert.match((await response.json()).error.message, /not currently in this ministry/);
  });

  it('explains a date left before the date joined', async () => {
    const client = createClient({
      perTable: {
        ministries: { rows: [ministryRow()] },
        ministry_members: {
          rows: [],
          error: {
            code: '23514',
            message:
              'new row for relation "ministry_members" violates check constraint "ministry_members_dates"',
          },
        },
      },
    });

    const response = await client.call(`/api/ministries/${MINISTRY_ID}/members/${MEMBER_ID}`, {
      method: 'PATCH',
      body: { leftOn: '2020-01-01' },
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.leftOn, /cannot be before/);
  });

  it('rejects a malformed date rather than passing it to the database', async () => {
    const client = createClient({ ...withChoir() });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}/members/${MEMBER_ID}`, {
      method: 'PATCH',
      body: { leftOn: 'yesterday' },
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('update'), false);
  });

  it('there is no DELETE for a membership — history is kept', async () => {
    const client = createClient({ ...withChoir() });
    const response = await client.call(`/api/ministries/${MINISTRY_ID}/members/${MEMBER_ID}`, {
      method: 'DELETE',
    });

    assert.equal(response.status, 405);
    assert.deepEqual((await response.json()).error.details, { allowed: ['PATCH'] });
  });
});

describe('escapeLikePattern', () => {
  it('escapes wildcards and the escape character itself, in that order', () => {
    assert.equal(escapeLikePattern('100%'), '100\\%');
    assert.equal(escapeLikePattern('a_b'), 'a\\_b');
    assert.equal(escapeLikePattern('\\%'), '\\\\\\%');
  });
});
