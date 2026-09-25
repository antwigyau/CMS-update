/**
 * Spiritual gifts (decision D7): the shared lookup and the per-member join.
 *
 * The distinction worth proving is the two permissions: editing the lookup is
 * `settings.manage` (church policy, like a setting), while attaching a gift to a
 * member is `members.update`. 'user-16' holds both; 'user-1' holds only the
 * member permissions, so it may attach a gift but not invent a new one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createGiftsService } from '../../src/services/gifts.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import { giftCreateSchema, memberGiftAddSchema } from '../../src/validation/gifts.schemas.js';
import {
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });
const MEMBER_ID = '11111111-2222-4333-8444-555555555555';
const GIFT_ID = '22222222-3333-4444-8555-666666666666';

const giftRow = (o = {}) => ({
  id: GIFT_ID,
  name: 'Teaching',
  description: null,
  is_active: true,
  sort_order: 100,
  ...o,
});
const memberGiftRow = (o = {}) => ({
  gift_id: GIFT_ID,
  noted_at: '2026-09-01',
  spiritual_gifts: { name: 'Teaching', description: null },
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
    gifts: createGiftsService({ getClient: recorder.getClient }),
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

describe('the spiritual-gift route table', () => {
  const routes = buildRouter({
    cfg,
    provider: createFakeProvider({}).provider,
    loadIdentity: createFakeIdentityLoader({}),
    gifts: createGiftsService({ getClient: createQueryRecorder().getClient }),
  })
    .list()
    .filter((route) => route.pattern.includes('spiritual-gifts'));

  it('registers six routes, none public', () => {
    assert.equal(routes.length, 6);
    for (const route of routes) assert.equal(route.isPublic, false);
  });

  it('edits the lookup under settings.manage, attaches under members.update', () => {
    const find = (method, pattern) =>
      routes.find((r) => r.method === method && r.pattern === pattern)?.permission;

    assert.equal(find('GET', '/spiritual-gifts'), 'members.view');
    assert.equal(find('POST', '/spiritual-gifts'), 'settings.manage');
    assert.equal(find('PATCH', '/spiritual-gifts/:id'), 'settings.manage');
    assert.equal(find('GET', '/members/:id/spiritual-gifts'), 'members.view');
    assert.equal(find('POST', '/members/:id/spiritual-gifts'), 'members.update');
    assert.equal(find('DELETE', '/members/:id/spiritual-gifts/:giftId'), 'members.update');
  });
});

/* ---- validation ---------------------------------------------------------- */

describe('spiritual-gift validation', () => {
  it('requires a name to create a gift', () => {
    assert.equal(giftCreateSchema.safeParse({}).success, false);
    assert.equal(giftCreateSchema.safeParse({ name: 'Teaching' }).success, true);
  });

  it('defaults a new gift to active', () => {
    assert.equal(giftCreateSchema.safeParse({ name: 'Teaching' }).data.isActive, true);
  });

  it('requires a uuid gift id to attach', () => {
    assert.equal(memberGiftAddSchema.safeParse({ giftId: 'nope' }).success, false);
    assert.equal(memberGiftAddSchema.safeParse({ giftId: GIFT_ID }).success, true);
  });
});

/* ---- service ------------------------------------------------------------- */

describe('the gifts service', () => {
  it('lists only active gifts unless asked for all', async () => {
    const recorder = createQueryRecorder({ rows: [giftRow()] });
    const gifts = createGiftsService({ getClient: recorder.getClient });

    await gifts.listGifts({ accessToken: 't' });
    assert.deepEqual(recorder.argsFor('eq'), ['is_active', true]);

    const recorder2 = createQueryRecorder({ rows: [giftRow()] });
    const gifts2 = createGiftsService({ getClient: recorder2.getClient });
    await gifts2.listGifts({ accessToken: 't', includeInactive: true });
    assert.equal(recorder2.called('eq'), false);
  });

  it('attaches a gift by inserting the member/gift pair', async () => {
    const recorder = createQueryRecorder({ rows: [memberGiftRow()] });
    const gifts = createGiftsService({ getClient: recorder.getClient });

    await gifts.addForMember({ accessToken: 't', memberId: MEMBER_ID, giftId: GIFT_ID });
    assert.deepEqual(recorder.argsFor('insert')[0], { member_id: MEMBER_ID, gift_id: GIFT_ID });
  });

  it('detaches scoped by both member and gift', async () => {
    const recorder = createQueryRecorder({ rows: [{ gift_id: GIFT_ID }] });
    const gifts = createGiftsService({ getClient: recorder.getClient });

    await gifts.removeForMember({ accessToken: 't', memberId: MEMBER_ID, giftId: GIFT_ID });
    const eqs = recorder.allArgsFor('eq');
    assert.ok(eqs.some(([c, v]) => c === 'member_id' && v === MEMBER_ID));
    assert.ok(eqs.some(([c, v]) => c === 'gift_id' && v === GIFT_ID));
  });
});

/* ---- routes -------------------------------------------------------------- */

describe('the spiritual-gift endpoints', () => {
  it('lets a settings admin add a gift to the lookup', async () => {
    const { call } = createClient({ rows: [giftRow()] });
    const response = await call('/api/spiritual-gifts', {
      method: 'POST',
      body: { name: 'Teaching' },
    });
    assert.equal(response.status, 201);
  });

  it('refuses lookup edits without settings.manage', async () => {
    const { call } = createClient({ as: 'user-1', rows: [giftRow()] });
    const response = await call('/api/spiritual-gifts', {
      method: 'POST',
      body: { name: 'Teaching' },
    });
    assert.equal(response.status, 403);
  });

  it('attaches a gift to a member with members.update', async () => {
    const { call } = createClient({ as: 'user-1', rows: [memberGiftRow()] });
    const response = await call(`/api/members/${MEMBER_ID}/spiritual-gifts`, {
      method: 'POST',
      body: { giftId: GIFT_ID },
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).data.name, 'Teaching');
  });

  it('lists a member’s gifts for a caller with members.view', async () => {
    const { call } = createClient({ rows: [memberGiftRow()] });
    const response = await call(`/api/members/${MEMBER_ID}/spiritual-gifts`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].giftId, GIFT_ID);
  });

  it('refuses the lookup to a caller without members.view', async () => {
    const { call } = createClient({ as: 'user-2', rows: [] });
    const response = await call('/api/spiritual-gifts');
    assert.equal(response.status, 403);
  });

  it('detaches a gift and answers 204', async () => {
    const { call } = createClient({ as: 'user-1', rows: [{ gift_id: GIFT_ID }] });
    const response = await call(`/api/members/${MEMBER_ID}/spiritual-gifts/${GIFT_ID}`, {
      method: 'DELETE',
    });
    assert.equal(response.status, 204);
  });
});
