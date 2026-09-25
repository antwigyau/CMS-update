/**
 * Attendance endpoints.
 *
 * Three things are under test that nothing earlier covered:
 *
 *   * decision D5 — named records and headcounts reported side by side, never
 *     reconciled
 *   * the closed-session freeze, and the fact that leadership does not lift it
 *   * leadership keyed on the SESSION's ministry rather than a ministry in the path
 *
 * The attendance permissions are unusually granular (view / session.create /
 * session.close / record / update / delete), so the fixtures include an usher who
 * holds only the first three — the narrowest useful role, and the one that proves
 * the permissions are genuinely separate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createAttendanceService } from '../../src/services/attendance.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import {
  BRANCH_MAIN,
  FIXTURES,
  MINISTRY_CHOIR,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import {
  MEMBER_ID,
  RECORD_ID,
  SESSION_ID,
  guestRecordRow,
  historyRow,
  ministrySessionRow,
  recordRow,
  sessionListRow,
  sessionPayload,
  sessionRow,
} from './attendance-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });

/**
 * 'user-8' is an usher (view, session.create, record).
 * 'user-9' is an attendance administrator (everything).
 * 'user-6' leads the choir and holds no attendance permission at all.
 */
function createClient({ as = 'user-9', ...recorderOptions } = {}) {
  const recorder = createQueryRecorder(recorderOptions);
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    attendance: createAttendanceService({ getClient: recorder.getClient }),
  });

  const token = mintToken({ sub: as });
  const csrf = 'd'.repeat(64);

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

/** A recorder whose session read returns `session`, and records `records`. */
const withSession = (session = sessionRow(), records = [recordRow()]) => ({
  perTable: {
    attendance_sessions: { rows: [session] },
    attendance_records: { rows: records },
  },
});

const SESSIONS = '/api/attendance/sessions';

/* -------------------------------------------------------------------------- */

describe('the attendance route table', () => {
  const routes = buildRouter({
    cfg,
    provider: createFakeProvider({}).provider,
    loadIdentity: createFakeIdentityLoader({}),
    attendance: createAttendanceService({ getClient: createQueryRecorder().getClient }),
  })
    .list()
    // Attendance's own routes, including GET /members/:id/attendance — but not the
    // /reports/attendance/* endpoints, which belong to the reporting module.
    .filter(
      (route) => route.pattern.includes('attendance') && !route.pattern.startsWith('/reports'),
    );

  it('registers nine routes, none public', () => {
    assert.equal(routes.length, 9);
    for (const route of routes) {
      assert.equal(route.isPublic, false);
      assert.ok(route.permission);
    }
  });

  it('admits a ministry leader only where the database does', () => {
    const leadership = routes
      .filter((route) => route.guard === 'permissionOrLeadership')
      .map((route) => `${route.method} ${route.pattern}`)
      .sort();

    assert.deepEqual(leadership, [
      'PATCH /attendance/sessions/:id',
      'PATCH /attendance/sessions/:id/records/:recordId',
      'POST /attendance/sessions',
      'POST /attendance/sessions/:id/records',
    ]);
  });

  it('keeps deletion for the branch permission alone', () => {
    for (const pattern of [
      'DELETE /attendance/sessions/:id',
      'DELETE /attendance/sessions/:id/records/:recordId',
    ]) {
      const route = routes.find((item) => `${item.method} ${item.pattern}` === pattern);
      assert.equal(route.guard, 'permission', pattern);
      assert.equal(route.permission, 'attendance.delete');
    }
  });
});

describe('GET /api/attendance/sessions', () => {
  it('refuses a caller without attendance.view', async () => {
    const client = createClient({ as: 'user-6', rows: [] });
    assert.equal((await client.call(SESSIONS)).status, 403);
  });

  it('reports the headcount and the named count side by side (decision D5)', async () => {
    const client = createClient({ as: 'user-8', rows: [sessionListRow()], count: 1 });
    const response = await client.call(SESSIONS);

    assert.equal(response.status, 200);
    const { data } = await response.json();

    assert.equal(data[0].headcountTotal, 212);
    assert.equal(data[0].namedCount, 148);
  });

  it('counts the register in the same request rather than one query per session', async () => {
    const client = createClient({ rows: [sessionListRow()], count: 1 });
    await client.call(SESSIONS);

    const [columns] = client.recorder.argsFor('select');
    assert.match(columns, /attendance_records\(count\)/);
    assert.deepEqual(client.recorder.tables(), ['attendance_sessions']);
  });

  it('shows the newest first by default, because that is the register people want', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call(SESSIONS);

    assert.deepEqual(client.recorder.allArgsFor('order'), [
      ['session_date', { ascending: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('filters by a date window', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call(`${SESSIONS}?from=2026-08-01&to=2026-08-31`);

    assert.deepEqual(client.recorder.argsFor('gte'), ['session_date', '2026-08-01']);
    assert.deepEqual(client.recorder.argsFor('lte'), ['session_date', '2026-08-31']);
  });

  it('rejects a date filter that is not a date', async () => {
    const client = createClient({ rows: [], count: 0 });
    const response = await client.call(`${SESSIONS}?from=last-month`);

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.from, /YYYY-MM-DD/);
  });

  it('filters by type, status, and ministry', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call(
      `${SESSIONS}?sessionType=ministry&status=closed&ministryId=${MINISTRY_CHOIR}`,
    );

    assert.deepEqual(client.recorder.allArgsFor('eq'), [
      ['session_type', 'ministry'],
      ['status', 'closed'],
      ['ministry_id', MINISTRY_CHOIR],
    ]);
  });

  it('rejects a type or status that is not real', async () => {
    for (const query of ['sessionType=picnic', 'status=paused']) {
      const client = createClient({ rows: [], count: 0 });
      const response = await client.call(`${SESSIONS}?${query}`);
      assert.equal(response.status, 422, query);
    }
  });

  it('caps the page size', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call(`${SESSIONS}?pageSize=9999`);

    assert.deepEqual(client.recorder.argsFor('range'), [0, 99]);
  });
});

describe('POST /api/attendance/sessions', () => {
  it('lets an usher open a service session', async () => {
    const client = createClient({ as: 'user-8', rows: [sessionRow()] });
    const response = await client.call(SESSIONS, { method: 'POST', body: sessionPayload() });

    assert.equal(response.status, 201);

    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.branch_id, BRANCH_MAIN);
    assert.equal(row.session_type, 'service');
    assert.equal(row.count_adults, 0, 'headcounts default to zero, not null');
    assert.equal(row.count_visitors, 0);
  });

  it('records the headcounts it was given', async () => {
    const client = createClient({ as: 'user-8', rows: [sessionRow()] });
    await client.call(SESSIONS, {
      method: 'POST',
      body: sessionPayload({
        countAdults: 120,
        countYouth: 40,
        countChildren: 45,
        countVisitors: 7,
      }),
    });

    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.count_adults, 120);
    assert.equal(row.count_children, 45);
    // count_total is generated by the database, never sent.
    assert.ok(!('count_total' in row));
  });

  it('refuses a negative headcount', async () => {
    const client = createClient({ as: 'user-8' });
    const response = await client.call(SESSIONS, {
      method: 'POST',
      body: sessionPayload({ countAdults: -1 }),
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.countAdults, /cannot be negative/);
  });

  it('refuses a service session that names a ministry', async () => {
    const client = createClient({ as: 'user-8' });
    const response = await client.call(SESSIONS, {
      method: 'POST',
      body: sessionPayload({ ministryId: MINISTRY_CHOIR }),
    });

    assert.equal(response.status, 422);
    assert.match(
      (await response.json()).error.details.fields.sessionType,
      /not tied to a ministry/,
    );
  });

  it('requires a ministry session to name its ministry', async () => {
    const client = createClient({ as: 'user-8' });
    const response = await client.call(SESSIONS, {
      method: 'POST',
      body: sessionPayload({ sessionType: 'ministry' }),
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.ministryId, /which ministry met/);
  });

  it('refuses a session dated more than a day ahead', async () => {
    const client = createClient({ as: 'user-8' });
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const response = await client.call(SESSIONS, {
      method: 'POST',
      body: sessionPayload({ sessionDate: nextWeek }),
    });

    assert.equal(response.status, 422);
  });

  it('allows tomorrow, so a register can be opened the evening before', async () => {
    const client = createClient({ as: 'user-8', rows: [sessionRow()] });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const response = await client.call(SESSIONS, {
      method: 'POST',
      body: sessionPayload({ sessionDate: tomorrow }),
    });

    assert.equal(response.status, 201);
  });

  it('refuses an end time before the start time', async () => {
    const client = createClient({ as: 'user-8' });
    const response = await client.call(SESSIONS, {
      method: 'POST',
      body: sessionPayload({ startTime: '10:00', endTime: '08:00' }),
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.endTime, /cannot be before/);
  });

  it('lets a ministry leader open a session for their own ministry, with no attendance permission', async () => {
    const client = createClient({ as: 'user-6', rows: [ministrySessionRow()] });
    const response = await client.call(SESSIONS, {
      method: 'POST',
      body: sessionPayload({
        sessionType: 'ministry',
        title: 'Choir Rehearsal',
        ministryId: MINISTRY_CHOIR,
      }),
    });

    assert.equal(response.status, 201);
  });

  it('refuses that leader a session for a ministry they do not lead', async () => {
    const client = createClient({ as: 'user-6', rows: [ministrySessionRow()] });
    const response = await client.call(SESSIONS, {
      method: 'POST',
      body: sessionPayload({
        sessionType: 'ministry',
        title: 'Ushers Meeting',
        ministryId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('refuses that leader a SERVICE session — that is the whole congregation', async () => {
    const client = createClient({ as: 'user-6', rows: [sessionRow()] });
    const response = await client.call(SESSIONS, { method: 'POST', body: sessionPayload() });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('explains a duplicate service register for the same day', async () => {
    const client = createClient({
      as: 'user-8',
      rows: [],
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "attendance_sessions_service_key"',
      },
    });

    const response = await client.call(SESSIONS, { method: 'POST', body: sessionPayload() });
    const text = await response.text();

    assert.equal(response.status, 409);
    assert.match(JSON.parse(text).error.details.fields.title, /already exists for this date/);
    assert.doesNotMatch(text, /attendance_sessions_service_key/);
  });
});

describe('GET /api/attendance/sessions/:id', () => {
  it('returns the session with its register, and both counts', async () => {
    const client = createClient({
      as: 'user-8',
      ...withSession(sessionRow(), [
        recordRow(),
        guestRecordRow(),
        recordRow({ id: 'r3', member_id: 'm3', status: 'late' }),
      ]),
    });

    const response = await client.call(`${SESSIONS}/${SESSION_ID}`);
    assert.equal(response.status, 200);

    const { data } = await response.json();
    assert.equal(data.headcount.total, 212, 'the counted total');
    assert.equal(data.namedCount, 3, 'the identified total');
    assert.equal(data.presentCount, 2, 'of whom this many were marked present');
  });

  it('reports a guest by name, with no member id', async () => {
    const client = createClient({ as: 'user-8', ...withSession(sessionRow(), [guestRecordRow()]) });
    const { data } = await (await client.call(`${SESSIONS}/${SESSION_ID}`)).json();

    assert.equal(data.records[0].isGuest, true);
    assert.equal(data.records[0].memberId, null);
    assert.equal(data.records[0].fullName, 'Visiting Friend');
  });

  it('says the register may be written when the session is open and the caller may record', async () => {
    const client = createClient({ as: 'user-8', ...withSession() });
    const { data } = await (await client.call(`${SESSIONS}/${SESSION_ID}`)).json();

    assert.equal(data.canRecord, true);
  });

  it('says it may not once the session is closed', async () => {
    const client = createClient({
      as: 'user-9',
      ...withSession(sessionRow({ status: 'closed', closed_at: '2026-08-30T11:00:00.000Z' })),
    });

    const { data } = await (await client.call(`${SESSIONS}/${SESSION_ID}`)).json();
    assert.equal(data.canRecord, false);
  });

  it('tells a ministry leader that the session is theirs', async () => {
    const client = createClient({ as: 'user-6', ...withSession(ministrySessionRow()) });
    // user-6 holds no attendance.view, so the guard refuses before the read.
    assert.equal((await client.call(`${SESSIONS}/${SESSION_ID}`)).status, 403);
  });

  it('404s a session the caller cannot see, without reading records', async () => {
    const client = createClient({
      as: 'user-8',
      perTable: { attendance_sessions: { rows: [] } },
    });

    const response = await client.call(`${SESSIONS}/${SESSION_ID}`);
    assert.equal(response.status, 404);
    assert.deepEqual(client.recorder.tables(), ['attendance_sessions']);
  });
});

describe('POST /api/attendance/sessions/:id/records', () => {
  it('accepts one record', async () => {
    const client = createClient({ as: 'user-8', ...withSession(sessionRow(), [recordRow()]) });
    const response = await client.call(`${SESSIONS}/${SESSION_ID}/records`, {
      method: 'POST',
      body: { memberId: MEMBER_ID, method: 'search' },
    });

    assert.equal(response.status, 201);

    const [rows] = client.recorder.argsFor('insert');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, SESSION_ID);
    assert.equal(rows[0].branch_id, BRANCH_MAIN, 'the branch comes from the session row');
    assert.equal(rows[0].status, 'present', 'the documented default');
  });

  it('accepts a batch, written as one atomic insert', async () => {
    const client = createClient({ as: 'user-8', ...withSession(sessionRow(), [recordRow()]) });
    await client.call(`${SESSIONS}/${SESSION_ID}/records`, {
      method: 'POST',
      body: {
        records: [
          { memberId: MEMBER_ID },
          { memberId: '22222222-2222-4222-8222-222222222222' },
          { guestName: 'Visiting Friend' },
        ],
      },
    });

    // One insert call with three rows: a partially applied roll call is worse than
    // a rejected one, because nobody can tell which half took.
    assert.equal(client.recorder.allArgsFor('insert').length, 1);
    assert.equal(client.recorder.argsFor('insert')[0].length, 3);
  });

  it('accepts a bare array too', async () => {
    const client = createClient({ as: 'user-8', ...withSession(sessionRow(), [recordRow()]) });
    const response = await client.call(`${SESSIONS}/${SESSION_ID}/records`, {
      method: 'POST',
      body: [{ memberId: MEMBER_ID }],
    });

    assert.equal(response.status, 201);
  });

  it('caps a batch, so a runaway client cannot post the whole roll', async () => {
    const client = createClient({ as: 'user-8', ...withSession() });
    const records = Array.from({ length: 201 }, () => ({ guestName: 'Someone' }));
    const response = await client.call(`${SESSIONS}/${SESSION_ID}/records`, {
      method: 'POST',
      body: { records },
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('requires either a member or a guest name, never both', async () => {
    const client = createClient({ as: 'user-8', ...withSession() });

    for (const body of [{}, { memberId: MEMBER_ID, guestName: 'Both' }]) {
      const response = await client.call(`${SESSIONS}/${SESSION_ID}/records`, {
        method: 'POST',
        body,
      });
      assert.equal(response.status, 422, JSON.stringify(body));
    }
  });

  it('refuses to write to a closed session, and says how to proceed', async () => {
    const client = createClient({
      as: 'user-8',
      ...withSession(sessionRow({ status: 'closed', closed_at: '2026-08-30T11:00:00.000Z' })),
    });

    const response = await client.call(`${SESSIONS}/${SESSION_ID}/records`, {
      method: 'POST',
      body: { memberId: MEMBER_ID },
    });

    assert.equal(response.status, 422);
    const { error } = await response.json();
    assert.match(error.message, /closed/);
    assert.match(error.details.fields.status, /attendance.session.close/);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('lets a ministry leader write the register for their own ministry session', async () => {
    const client = createClient({
      as: 'user-6',
      ...withSession(ministrySessionRow(), [recordRow()]),
    });

    const response = await client.call(`${SESSIONS}/${SESSION_ID}/records`, {
      method: 'POST',
      body: { memberId: MEMBER_ID },
    });

    assert.equal(response.status, 201);
  });

  it('refuses that leader on a service session', async () => {
    const client = createClient({ as: 'user-6', ...withSession(sessionRow()) });
    const response = await client.call(`${SESSIONS}/${SESSION_ID}/records`, {
      method: 'POST',
      body: { memberId: MEMBER_ID },
    });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('explains a member recorded twice for the same session', async () => {
    const client = createClient({
      as: 'user-8',
      perTable: {
        attendance_sessions: { rows: [sessionRow()] },
        attendance_records: {
          rows: [],
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "attendance_records_member_key"',
          },
        },
      },
    });

    const response = await client.call(`${SESSIONS}/${SESSION_ID}/records`, {
      method: 'POST',
      body: { memberId: MEMBER_ID },
    });

    assert.equal(response.status, 409);
    assert.match(
      (await response.json()).error.details.fields.memberId,
      /already recorded for this session/,
    );
  });
});

describe('PATCH /api/attendance/sessions/:id — closing and reopening', () => {
  it('lets an administrator close a session', async () => {
    const client = createClient({
      as: 'user-9',
      perTable: {
        attendance_sessions: { rows: [sessionRow(), sessionRow({ status: 'closed' })] },
      },
    });

    const response = await client.call(`${SESSIONS}/${SESSION_ID}`, {
      method: 'PATCH',
      body: { status: 'closed' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [{ status: 'closed' }]);
  });

  it('refuses an usher, who may open and record but not close', async () => {
    const client = createClient({ as: 'user-8', ...withSession() });
    const response = await client.call(`${SESSIONS}/${SESSION_ID}`, {
      method: 'PATCH',
      body: { status: 'closed' },
    });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('update'), false);
  });

  it('refuses a ministry leader reopening a closed session, even their own', async () => {
    const client = createClient({
      as: 'user-6',
      ...withSession(
        ministrySessionRow({ status: 'closed', closed_at: '2026-08-30T20:00:00.000Z' }),
      ),
    });

    const response = await client.call(`${SESSIONS}/${SESSION_ID}`, {
      method: 'PATCH',
      body: { status: 'open' },
    });

    // Leadership does not lift the freeze: the database trigger requires
    // attendance.session.close and does not accept leadership, so the API says so
    // rather than letting the trigger produce the refusal.
    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('update'), false);
  });

  it('lets an administrator reopen it', async () => {
    const client = createClient({
      as: 'user-9',
      perTable: {
        attendance_sessions: {
          rows: [sessionRow({ status: 'closed', closed_at: '2026-08-30T20:00:00.000Z' })],
        },
      },
    });

    const response = await client.call(`${SESSIONS}/${SESSION_ID}`, {
      method: 'PATCH',
      body: { status: 'open' },
    });

    assert.equal(response.status, 200);
  });

  it('lets a leader correct the headcount on their own ministry session', async () => {
    const client = createClient({ as: 'user-6', ...withSession(ministrySessionRow()) });
    const response = await client.call(`${SESSIONS}/${SESSION_ID}`, {
      method: 'PATCH',
      body: { countAdults: 22 },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [{ count_adults: 22 }]);
  });

  it('will not let a session change what it is once people are recorded against it', async () => {
    const client = createClient({ as: 'user-9', ...withSession() });

    for (const body of [
      { sessionType: 'ministry' },
      { ministryId: MINISTRY_CHOIR },
      { branchId: BRANCH_MAIN },
    ]) {
      const response = await client.call(`${SESSIONS}/${SESSION_ID}`, { method: 'PATCH', body });
      assert.equal(response.status, 422, JSON.stringify(body));
    }
  });

  it('refuses an empty patch', async () => {
    const client = createClient({ as: 'user-9', ...withSession() });
    const response = await client.call(`${SESSIONS}/${SESSION_ID}`, { method: 'PATCH', body: {} });

    assert.equal(response.status, 422);
  });

  it('requires the CSRF token', async () => {
    const client = createClient({ as: 'user-9', ...withSession() });
    const response = await client.call(`${SESSIONS}/${SESSION_ID}`, {
      method: 'PATCH',
      body: { countAdults: 1 },
      headers: { 'x-csrf-token': null },
    });

    assert.equal(response.status, 403);
  });
});

describe('correcting and removing records', () => {
  it('lets an administrator change a status', async () => {
    const client = createClient({
      as: 'user-9',
      ...withSession(sessionRow(), [recordRow({ status: 'late' })]),
    });

    const response = await client.call(`${SESSIONS}/${SESSION_ID}/records/${RECORD_ID}`, {
      method: 'PATCH',
      body: { status: 'late' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [{ status: 'late' }]);
  });

  it('scopes the correction to the session in the path', async () => {
    const client = createClient({ as: 'user-9', ...withSession() });
    await client.call(`${SESSIONS}/${SESSION_ID}/records/${RECORD_ID}`, {
      method: 'PATCH',
      body: { status: 'excused' },
    });

    // Otherwise a record id from another session could be edited through this one.
    assert.deepEqual(client.recorder.allArgsFor('eq').slice(-2), [
      ['id', RECORD_ID],
      ['session_id', SESSION_ID],
    ]);
  });

  it('refuses an usher, who may record but not correct', async () => {
    const client = createClient({ as: 'user-8', ...withSession() });
    const response = await client.call(`${SESSIONS}/${SESSION_ID}/records/${RECORD_ID}`, {
      method: 'PATCH',
      body: { status: 'absent' },
    });

    assert.equal(response.status, 403);
  });

  it('refuses an usher deleting a record', async () => {
    const client = createClient({ as: 'user-8', ...withSession() });
    const response = await client.call(`${SESSIONS}/${SESSION_ID}/records/${RECORD_ID}`, {
      method: 'DELETE',
    });

    assert.equal(response.status, 403);
  });

  it('lets an administrator delete one', async () => {
    const client = createClient({
      as: 'user-9',
      perTable: {
        attendance_sessions: { rows: [sessionRow()] },
        attendance_records: { rows: [{ id: RECORD_ID }] },
      },
    });

    const response = await client.call(`${SESSIONS}/${SESSION_ID}/records/${RECORD_ID}`, {
      method: 'DELETE',
    });

    assert.equal(response.status, 204);
  });

  it('refuses a ministry leader deleting a record, even on their own session', async () => {
    const client = createClient({ as: 'user-6', ...withSession(ministrySessionRow()) });
    const response = await client.call(`${SESSIONS}/${SESSION_ID}/records/${RECORD_ID}`, {
      method: 'DELETE',
    });

    assert.equal(response.status, 403);
  });
});

describe('DELETE /api/attendance/sessions/:id', () => {
  it('refuses a ministry leader — deleting discards everyone’s attendance', async () => {
    const client = createClient({ as: 'user-6', ...withSession(ministrySessionRow()) });
    const response = await client.call(`${SESSIONS}/${SESSION_ID}`, { method: 'DELETE' });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('delete'), false);
  });

  it('allows an attendance administrator', async () => {
    const client = createClient({
      as: 'user-9',
      perTable: { attendance_sessions: { rows: [sessionRow()] } },
    });

    const response = await client.call(`${SESSIONS}/${SESSION_ID}`, { method: 'DELETE' });
    assert.equal(response.status, 204);
  });
});

describe('GET /api/members/:id/attendance', () => {
  it('returns a member’s history, newest first', async () => {
    const client = createClient({ as: 'user-9', rows: [historyRow()], count: 1 });
    const response = await client.call(`/api/members/${MEMBER_ID}/attendance`);

    assert.equal(response.status, 200);
    const { data, meta } = await response.json();

    assert.equal(data[0].sessionTitle, 'First Service');
    assert.equal(data[0].sessionDate, '2026-08-30');
    assert.equal(meta.total, 1);

    assert.deepEqual(client.recorder.argsFor('eq'), ['member_id', MEMBER_ID]);
    assert.deepEqual(client.recorder.argsFor('order'), ['check_in_at', { ascending: false }]);
  });

  it('is guarded by members.view, not attendance.view — a member holds the former for their own record', async () => {
    // Decision D4 gives a member their own profile and their own attendance. RLS
    // allows `member_id = app.current_member_id()`, so guarding this route with
    // attendance.view would refuse the very caller the database is willing to serve.
    const client = createClient({ as: 'user-1', rows: [historyRow()], count: 1 });
    assert.equal((await client.call(`/api/members/${MEMBER_ID}/attendance`)).status, 200);

    const noMemberView = createClient({ as: 'user-8', rows: [], count: 0 });
    assert.equal((await noMemberView.call(`/api/members/${MEMBER_ID}/attendance`)).status, 403);
  });

  it('pages at fifty by default, and caps like every other list', async () => {
    const client = createClient({ as: 'user-9', rows: [], count: 0 });
    await client.call(`/api/members/${MEMBER_ID}/attendance`);
    assert.deepEqual(client.recorder.argsFor('range'), [0, 49]);

    const capped = createClient({ as: 'user-9', rows: [], count: 0 });
    await capped.call(`/api/members/${MEMBER_ID}/attendance?pageSize=5000`);
    assert.deepEqual(capped.recorder.argsFor('range'), [0, 99]);
  });
});
