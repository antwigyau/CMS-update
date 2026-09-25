/**
 * Event endpoints.
 *
 * The distinctive concern here is the split between editing an event and
 * *announcing* it. `events.publish` is a separate permission, so publishing has its
 * own endpoint and `status` is absent from the update schema — otherwise anyone who
 * could fix a typo could also tell the whole congregation the event is happening.
 *
 * The fixtures make the split concrete: 'user-10' may create and edit but not
 * publish; 'user-11' may do everything.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createEventsService } from '../../src/services/events.service.js';
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
  CATEGORY_ID,
  EVENT_ID,
  MEMBER_ID,
  REGISTRATION_ID,
  categoryRow,
  eventListRow,
  eventPayload,
  eventRow,
  guestRegistrationRow,
  ministryEventRow,
  registrationRow,
} from './events-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });

/** 'user-10' edits but cannot publish; 'user-11' can do everything. */
function createClient({ as = 'user-11', ...recorderOptions } = {}) {
  const recorder = createQueryRecorder(recorderOptions);
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    events: createEventsService({ getClient: recorder.getClient }),
  });

  const token = mintToken({ sub: as });
  const csrf = 'e'.repeat(64);

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

const withEvent = (event = eventRow(), registrations = [registrationRow()]) => ({
  perTable: {
    events: { rows: [event] },
    event_registrations: { rows: registrations, count: registrations.length },
  },
});

/* -------------------------------------------------------------------------- */

describe('the event route table', () => {
  const routes = buildRouter({
    cfg,
    provider: createFakeProvider({}).provider,
    loadIdentity: createFakeIdentityLoader({}),
    events: createEventsService({ getClient: createQueryRecorder().getClient }),
  })
    .list()
    .filter((route) => route.pattern.startsWith('/event'));

  it('registers eleven routes, none public', () => {
    assert.equal(routes.length, 11);
    for (const route of routes) {
      assert.equal(route.isPublic, false);
      assert.ok(route.permission);
    }
  });

  it('has no route that takes a status as a field edit', () => {
    // Publishing is its own endpoint; a PATCH carrying `status` would bypass the
    // events.publish permission.
    assert.ok(routes.some((route) => route.pattern === '/events/:id/status'));
  });

  it('keeps registration management on its own permission', () => {
    const registrationRoutes = routes.filter((route) => route.pattern.includes('/registrations'));
    assert.equal(registrationRoutes.length, 4);

    for (const route of registrationRoutes) {
      const expected = route.method === 'GET' ? 'events.view' : 'events.attendance.manage';
      assert.equal(route.permission, expected, `${route.method} ${route.pattern}`);
    }
  });

  it('admits a ministry leader to create, edit, and transition — but nothing else', () => {
    const leadership = routes
      .filter((route) => route.guard === 'permissionOrLeadership')
      .map((route) => `${route.method} ${route.pattern}`)
      .sort();

    assert.deepEqual(leadership, ['PATCH /events/:id', 'POST /events', 'POST /events/:id/status']);
  });
});

describe('GET /api/event-categories', () => {
  it('returns the active shared vocabulary', async () => {
    const client = createClient({ rows: [categoryRow()] });
    const response = await client.call('/api/event-categories');

    assert.equal(response.status, 200);
    const { data } = await response.json();

    assert.equal(data[0].name, 'Conference');
    assert.equal(data[0].colour, '#7c3aed');
    assert.deepEqual(client.recorder.argsFor('eq'), ['is_active', true]);
  });

  it('includes retired categories only when asked', async () => {
    const client = createClient({ rows: [categoryRow({ is_active: false })] });
    await client.call('/api/event-categories?all=1');

    assert.equal(client.recorder.called('eq'), false);
  });
});

describe('GET /api/events', () => {
  it('refuses a caller without events.view', async () => {
    const client = createClient({ as: 'user-8', rows: [] });
    assert.equal((await client.call('/api/events')).status, 403);
  });

  it('returns events with their category, and how many have registered', async () => {
    const client = createClient({ rows: [eventListRow()], count: 1 });
    const response = await client.call('/api/events');

    assert.equal(response.status, 200);
    const { data } = await response.json();

    assert.equal(data[0].title, 'Annual Harvest Service');
    assert.equal(data[0].categoryName, 'Conference');
    assert.equal(data[0].registeredCount, 42);
    assert.equal(data[0].capacity, 300);
  });

  it('counts registrations in the same request', async () => {
    const client = createClient({ rows: [eventListRow()], count: 1 });
    await client.call('/api/events');

    const [columns] = client.recorder.argsFor('select');
    assert.match(columns, /event_registrations\(count\)/);
    assert.deepEqual(client.recorder.tables(), ['events']);
  });

  it('orders by start time ascending, which is what a calendar wants', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/events');

    assert.deepEqual(client.recorder.allArgsFor('order'), [
      ['starts_at', { ascending: true }],
      ['id', { ascending: true }],
    ]);
  });

  it('filters by a date window on the start time', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/events?from=2026-09-01&to=2026-09-30');

    assert.deepEqual(client.recorder.argsFor('gte'), ['starts_at', '2026-09-01T00:00:00.000Z']);
    assert.deepEqual(client.recorder.argsFor('lte'), ['starts_at', '2026-09-30T00:00:00.000Z']);
  });

  it('rejects a date filter that is not a date', async () => {
    const client = createClient({ rows: [], count: 0 });
    const response = await client.call('/api/events?from=next-autumn');

    assert.equal(response.status, 422);
  });

  it('filters by status, category, and ministry', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call(
      `/api/events?status=published&categoryId=${CATEGORY_ID}&ministryId=${MINISTRY_CHOIR}`,
    );

    assert.deepEqual(client.recorder.allArgsFor('eq'), [
      ['status', 'published'],
      ['category_id', CATEGORY_ID],
      ['ministry_id', MINISTRY_CHOIR],
    ]);
  });

  it('rejects a status that is not real', async () => {
    const client = createClient({ rows: [], count: 0 });
    assert.equal((await client.call('/api/events?status=maybe')).status, 422);
  });

  it('searches by title with wildcards escaped', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/events?search=%25harvest');

    assert.deepEqual(client.recorder.argsFor('ilike'), ['title', '%\\%harvest%']);
  });

  it('caps the page size', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/events?pageSize=9999');

    assert.deepEqual(client.recorder.argsFor('range'), [0, 99]);
  });
});

describe('POST /api/events', () => {
  it('creates an event as a draft, never published', async () => {
    const client = createClient({ rows: [eventRow()] });
    const response = await client.call('/api/events', { method: 'POST', body: eventPayload() });

    assert.equal(response.status, 201);

    const [row] = client.recorder.argsFor('insert');
    assert.equal(
      row.status,
      'draft',
      'an event cannot be announced by the request that creates it',
    );
    assert.equal(row.branch_id, BRANCH_MAIN);
    assert.equal(row.is_public, false, 'the documented default');
  });

  it('refuses a status supplied by the caller', async () => {
    const client = createClient({ rows: [eventRow()] });
    const response = await client.call('/api/events', {
      method: 'POST',
      body: eventPayload({ status: 'published' }),
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('normalises the start and end to ISO instants', async () => {
    const client = createClient({ rows: [eventRow()] });
    await client.call('/api/events', {
      method: 'POST',
      body: eventPayload({ startsAt: '2026-12-01T09:00:00+00:00', endsAt: '2026-12-01T11:00:00Z' }),
    });

    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.starts_at, '2026-12-01T09:00:00.000Z');
    assert.equal(row.ends_at, '2026-12-01T11:00:00.000Z');
  });

  it('honours an explicit offset, so an event is the same instant everywhere', async () => {
    const client = createClient({ rows: [eventRow()] });
    await client.call('/api/events', {
      method: 'POST',
      body: eventPayload({
        startsAt: '2026-12-01T09:00:00+03:00',
        endsAt: '2026-12-01T12:00:00+03:00',
      }),
    });

    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.starts_at, '2026-12-01T06:00:00.000Z', '09:00 in +03:00 is 06:00 UTC');
  });

  it('refuses an event that ends before it starts', async () => {
    const client = createClient();
    const response = await client.call('/api/events', {
      method: 'POST',
      body: eventPayload({ startsAt: '2026-12-01T12:00:00Z', endsAt: '2026-12-01T09:00:00Z' }),
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.endsAt, /end after it starts/);
  });

  it('refuses a zero-length event', async () => {
    const client = createClient();
    const response = await client.call('/api/events', {
      method: 'POST',
      body: eventPayload({ startsAt: '2026-12-01T09:00:00Z', endsAt: '2026-12-01T09:00:00Z' }),
    });

    assert.equal(response.status, 422);
  });

  it('refuses a capacity of zero', async () => {
    const client = createClient();
    const response = await client.call('/api/events', {
      method: 'POST',
      body: eventPayload({ capacity: 0 }),
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.capacity, /nobody can attend/);
  });

  it('lets a ministry leader create an event for their own ministry', async () => {
    const client = createClient({ as: 'user-6', rows: [ministryEventRow()] });
    const response = await client.call('/api/events', {
      method: 'POST',
      body: eventPayload({ title: 'Choir Concert', ministryId: MINISTRY_CHOIR }),
    });

    assert.equal(response.status, 201);
  });

  it('refuses that leader an event for a ministry they do not lead', async () => {
    const client = createClient({ as: 'user-6', rows: [eventRow()] });
    const response = await client.call('/api/events', {
      method: 'POST',
      body: eventPayload({ ministryId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('refuses that leader an event tied to no ministry at all', async () => {
    const client = createClient({ as: 'user-6', rows: [eventRow()] });
    const response = await client.call('/api/events', { method: 'POST', body: eventPayload() });

    assert.equal(response.status, 403);
  });

  it('explains a cross-branch ministry as a field error', async () => {
    const client = createClient({
      rows: [],
      error: {
        code: '23503',
        message:
          'insert or update on table "events" violates foreign key constraint "events_ministry_fkey"',
      },
    });

    const response = await client.call('/api/events', {
      method: 'POST',
      body: eventPayload({ ministryId: MINISTRY_CHOIR }),
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.ministryId, /not in this branch/);
  });
});

describe('GET /api/events/:id', () => {
  it('returns the event with its capacity picture and what the caller may do', async () => {
    const client = createClient({
      perTable: {
        events: { rows: [eventRow({ capacity: 50, status: 'published' })] },
        event_registrations: { rows: [], count: 12 },
      },
    });

    const response = await client.call(`/api/events/${EVENT_ID}`);
    assert.equal(response.status, 200);

    const { data } = await response.json();
    assert.equal(data.registeredCount, 12);
    assert.equal(data.placesLeft, 38);
    assert.equal(data.canPublish, true);
    assert.equal(data.canManageRegistrations, true);
  });

  it('reports places left as unknown when there is no capacity', async () => {
    const client = createClient({ ...withEvent(eventRow({ capacity: null })) });
    const { data } = await (await client.call(`/api/events/${EVENT_ID}`)).json();

    assert.equal(data.placesLeft, null, 'null means unlimited, which is not the same as zero');
  });

  it('tells an editor they may not publish', async () => {
    const client = createClient({ as: 'user-10', ...withEvent() });
    const { data } = await (await client.call(`/api/events/${EVENT_ID}`)).json();

    assert.equal(data.canEdit, true);
    assert.equal(data.canPublish, false);
    assert.equal(data.canDelete, false);
    assert.equal(data.canManageRegistrations, false);
  });

  it('reports every capability the frontend renders a control for', async () => {
    const client = createClient({ ...withEvent() });
    const { data } = await (await client.call(`/api/events/${EVENT_ID}`)).json();

    // The detail page decides what to show from these flags rather than from
    // permission names, so a missing one silently hides a control.
    for (const flag of [
      'canEdit',
      'canPublish',
      'canDelete',
      'canManageRegistrations',
      'youLead',
    ]) {
      assert.equal(typeof data[flag], 'boolean', `${flag} must always be present`);
    }
  });

  it('tells a ministry leader the event is theirs', async () => {
    const client = createClient({ as: 'user-6', ...withEvent(ministryEventRow()) });
    // user-6 holds events.view, so the read succeeds.
    const { data } = await (await client.call(`/api/events/${EVENT_ID}`)).json();

    assert.equal(data.youLead, true);
    assert.equal(data.canEdit, true);
    assert.equal(data.canPublish, false);
  });

  it('404s an event the caller cannot see', async () => {
    const client = createClient({ perTable: { events: { rows: [] } } });
    assert.equal((await client.call(`/api/events/${EVENT_ID}`)).status, 404);
  });
});

/* -------------------------------------------------------------------------- */
/* Editing versus announcing                                                  */
/* -------------------------------------------------------------------------- */

describe('PATCH /api/events/:id', () => {
  it('lets an editor correct the details', async () => {
    const client = createClient({ as: 'user-10', ...withEvent() });
    const response = await client.call(`/api/events/${EVENT_ID}`, {
      method: 'PATCH',
      body: { venue: 'Upper hall' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [{ venue: 'Upper hall' }]);
  });

  it('will not accept a status, so publishing cannot happen through an edit', async () => {
    const client = createClient({ ...withEvent() });
    const response = await client.call(`/api/events/${EVENT_ID}`, {
      method: 'PATCH',
      body: { status: 'published' },
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('update'), false);
  });

  it('lets a ministry leader edit their own ministry’s event', async () => {
    const client = createClient({ as: 'user-6', ...withEvent(ministryEventRow()) });
    const response = await client.call(`/api/events/${EVENT_ID}`, {
      method: 'PATCH',
      body: { venue: 'Rehearsal room' },
    });

    assert.equal(response.status, 200);
  });

  it('refuses a leader on an event that is not their ministry’s', async () => {
    const client = createClient({ as: 'user-6', ...withEvent(eventRow()) });
    const response = await client.call(`/api/events/${EVENT_ID}`, {
      method: 'PATCH',
      body: { venue: 'Anywhere' },
    });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('update'), false);
  });

  it('refuses a leader moving the event to a different ministry', async () => {
    const client = createClient({ as: 'user-6', ...withEvent(ministryEventRow()) });
    const response = await client.call(`/api/events/${EVENT_ID}`, {
      method: 'PATCH',
      // Changing the ministry changes who may edit the event, so it needs the
      // branch permission rather than the leader's own authority.
      body: { ministryId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('update'), false);
  });

  it('requires the CSRF token', async () => {
    const client = createClient({ ...withEvent() });
    const response = await client.call(`/api/events/${EVENT_ID}`, {
      method: 'PATCH',
      body: { venue: 'Hall' },
      headers: { 'x-csrf-token': null },
    });

    assert.equal(response.status, 403);
  });
});

describe('POST /api/events/:id/status', () => {
  it('lets an events administrator publish a draft', async () => {
    const client = createClient({ ...withEvent(eventRow({ status: 'draft' })) });
    const response = await client.call(`/api/events/${EVENT_ID}/status`, {
      method: 'POST',
      body: { status: 'published' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [{ status: 'published' }]);
  });

  it('refuses an editor who may change everything else', async () => {
    const client = createClient({ as: 'user-10', ...withEvent(eventRow({ status: 'draft' })) });
    const response = await client.call(`/api/events/${EVENT_ID}/status`, {
      method: 'POST',
      body: { status: 'published' },
    });

    // This is the whole point of the split: correcting a typo and announcing the
    // event to the congregation are different acts.
    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('update'), false);
  });

  it('refuses a ministry leader publishing their own event', async () => {
    const client = createClient({
      as: 'user-6',
      ...withEvent(ministryEventRow({ status: 'draft' })),
    });
    const response = await client.call(`/api/events/${EVENT_ID}/status`, {
      method: 'POST',
      body: { status: 'published' },
    });

    assert.equal(response.status, 403);
  });

  it('lets an editor cancel, which does not announce anything', async () => {
    const client = createClient({ as: 'user-10', ...withEvent(eventRow({ status: 'published' })) });
    const response = await client.call(`/api/events/${EVENT_ID}/status`, {
      method: 'POST',
      body: { status: 'cancelled' },
    });

    assert.equal(response.status, 200);
  });

  it('refuses a transition that makes no sense', async () => {
    const client = createClient({ ...withEvent(eventRow({ status: 'completed' })) });
    const response = await client.call(`/api/events/${EVENT_ID}/status`, {
      method: 'POST',
      body: { status: 'published' },
    });

    assert.equal(response.status, 409);
    assert.match((await response.json()).error.message, /cannot go from completed to published/);
  });

  it('refuses a status the event already has', async () => {
    const client = createClient({ ...withEvent(eventRow({ status: 'published' })) });
    const response = await client.call(`/api/events/${EVENT_ID}/status`, {
      method: 'POST',
      body: { status: 'published' },
    });

    assert.equal(response.status, 409);
    assert.match((await response.json()).error.message, /already published/);
  });

  it('refuses a status that is not a status', async () => {
    const client = createClient({ ...withEvent() });
    const response = await client.call(`/api/events/${EVENT_ID}/status`, {
      method: 'POST',
      body: { status: 'postponed' },
    });

    assert.equal(response.status, 422);
  });
});

describe('DELETE /api/events/:id', () => {
  it('refuses an editor — cancelling is the reversible option', async () => {
    const client = createClient({ as: 'user-10', ...withEvent() });
    const response = await client.call(`/api/events/${EVENT_ID}`, { method: 'DELETE' });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('delete'), false);
  });

  it('refuses a ministry leader on their own event', async () => {
    const client = createClient({ as: 'user-6', ...withEvent(ministryEventRow()) });
    assert.equal((await client.call(`/api/events/${EVENT_ID}`, { method: 'DELETE' })).status, 403);
  });

  it('allows an events administrator', async () => {
    const client = createClient({ perTable: { events: { rows: [eventRow()] } } });
    const response = await client.call(`/api/events/${EVENT_ID}`, { method: 'DELETE' });

    assert.equal(response.status, 204);
  });
});

/* -------------------------------------------------------------------------- */
/* Registrations                                                              */
/* -------------------------------------------------------------------------- */

describe('event registrations', () => {
  it('lists them with the capacity for context', async () => {
    const client = createClient({
      perTable: {
        events: { rows: [eventRow({ capacity: 100 })] },
        event_registrations: { rows: [registrationRow(), guestRegistrationRow()] },
      },
    });

    const response = await client.call(`/api/events/${EVENT_ID}/registrations`);
    assert.equal(response.status, 200);

    const { data, meta } = await response.json();
    assert.equal(meta.capacity, 100);
    assert.equal(data[0].fullName, 'Grace Mensah');
    assert.equal(data[1].isGuest, true);
    assert.equal(data[1].fullName, 'Visiting Friend');
  });

  it('registers a member, taking the branch from the event', async () => {
    const client = createClient({ ...withEvent(eventRow({ status: 'published' })) });
    const response = await client.call(`/api/events/${EVENT_ID}/registrations`, {
      method: 'POST',
      body: { memberId: MEMBER_ID },
    });

    assert.equal(response.status, 201);

    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.event_id, EVENT_ID);
    assert.equal(row.branch_id, BRANCH_MAIN);
    assert.equal(row.member_id, MEMBER_ID);
  });

  it('registers a guest with their own contact details', async () => {
    const client = createClient({
      perTable: {
        events: { rows: [eventRow({ status: 'published' })] },
        event_registrations: { rows: [guestRegistrationRow()], count: 0 },
      },
    });

    const response = await client.call(`/api/events/${EVENT_ID}/registrations`, {
      method: 'POST',
      body: { guestName: 'Visiting Friend', guestPhone: '+233201234567' },
    });

    assert.equal(response.status, 201);
    assert.equal(client.recorder.argsFor('insert')[0].guest_name, 'Visiting Friend');
  });

  it('requires either a member or a guest, never both', async () => {
    const client = createClient({ ...withEvent() });

    for (const body of [{}, { memberId: MEMBER_ID, guestName: 'Both' }]) {
      const response = await client.call(`/api/events/${EVENT_ID}/registrations`, {
        method: 'POST',
        body,
      });
      assert.equal(response.status, 422, JSON.stringify(body));
    }
  });

  it('refuses guest contact details on a member registration', async () => {
    const client = createClient({ ...withEvent() });
    const response = await client.call(`/api/events/${EVENT_ID}/registrations`, {
      method: 'POST',
      body: { memberId: MEMBER_ID, guestPhone: '+233201234567' },
    });

    // A member's contact details come from their record; a second copy here would
    // go stale and nobody would know which was current.
    assert.equal(response.status, 422);
  });

  it('refuses a registration when the event is full', async () => {
    const client = createClient({
      perTable: {
        events: { rows: [eventRow({ capacity: 2, status: 'published' })] },
        event_registrations: { rows: [], count: 2 },
      },
    });

    const response = await client.call(`/api/events/${EVENT_ID}/registrations`, {
      method: 'POST',
      body: { memberId: MEMBER_ID },
    });

    assert.equal(response.status, 409);
    assert.match((await response.json()).error.details.fields.memberId, /All 2 places are taken/);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('allows one more when a place remains', async () => {
    const client = createClient({
      perTable: {
        events: { rows: [eventRow({ capacity: 3, status: 'published' })] },
        event_registrations: { rows: [registrationRow()], count: 2 },
      },
    });

    const response = await client.call(`/api/events/${EVENT_ID}/registrations`, {
      method: 'POST',
      body: { memberId: MEMBER_ID },
    });

    assert.equal(response.status, 201);
  });

  it('does not check capacity when there is none', async () => {
    const client = createClient({ ...withEvent(eventRow({ capacity: null })) });
    await client.call(`/api/events/${EVENT_ID}/registrations`, {
      method: 'POST',
      body: { memberId: MEMBER_ID },
    });

    // No head-count query: an unlimited event needs no capacity check at all.
    assert.equal(
      client.recorder.tables().filter((table) => table === 'event_registrations').length,
      1,
      'exactly one registrations query — the insert',
    );
  });

  it('refuses a registration for a cancelled event', async () => {
    const client = createClient({ ...withEvent(eventRow({ status: 'cancelled' })) });
    const response = await client.call(`/api/events/${EVENT_ID}/registrations`, {
      method: 'POST',
      body: { memberId: MEMBER_ID },
    });

    assert.equal(response.status, 409);
    assert.match((await response.json()).error.message, /cancelled/);
  });

  it('explains a member registered twice', async () => {
    const client = createClient({
      perTable: {
        events: { rows: [eventRow({ status: 'published' })] },
        event_registrations: {
          rows: [],
          count: 0,
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "event_registrations_member_key"',
          },
        },
      },
    });

    const response = await client.call(`/api/events/${EVENT_ID}/registrations`, {
      method: 'POST',
      body: { memberId: MEMBER_ID },
    });

    assert.equal(response.status, 409);
    assert.match(
      (await response.json()).error.details.fields.memberId,
      /already registered for this event/,
    );
  });

  it('records a no-show, scoped to the event in the path', async () => {
    const client = createClient({
      ...withEvent(eventRow(), [registrationRow({ status: 'no_show' })]),
    });
    const response = await client.call(`/api/events/${EVENT_ID}/registrations/${REGISTRATION_ID}`, {
      method: 'PATCH',
      body: { status: 'no_show' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.allArgsFor('eq').slice(-2), [
      ['id', REGISTRATION_ID],
      ['event_id', EVENT_ID],
    ]);
  });

  it('refuses an editor, who may not manage registrations', async () => {
    const client = createClient({ as: 'user-10', ...withEvent() });

    for (const options of [
      { method: 'POST', path: '/registrations', body: { memberId: MEMBER_ID } },
      { method: 'PATCH', path: `/registrations/${REGISTRATION_ID}`, body: { status: 'cancelled' } },
      { method: 'DELETE', path: `/registrations/${REGISTRATION_ID}` },
    ]) {
      const response = await client.call(`/api/events/${EVENT_ID}${options.path}`, {
        method: options.method,
        body: options.body,
      });
      assert.equal(response.status, 403, `${options.method} ${options.path}`);
    }
  });

  it('removes a registration', async () => {
    const client = createClient({
      perTable: {
        events: { rows: [eventRow()] },
        event_registrations: { rows: [{ id: REGISTRATION_ID }] },
      },
    });

    const response = await client.call(`/api/events/${EVENT_ID}/registrations/${REGISTRATION_ID}`, {
      method: 'DELETE',
    });

    assert.equal(response.status, 204);
  });

  it('reports 404 for a registration that is not on this event', async () => {
    const client = createClient({
      perTable: { events: { rows: [eventRow()] }, event_registrations: { rows: [] } },
    });

    const response = await client.call(`/api/events/${EVENT_ID}/registrations/${REGISTRATION_ID}`, {
      method: 'PATCH',
      body: { status: 'cancelled' },
    });

    assert.equal(response.status, 404);
  });
});
