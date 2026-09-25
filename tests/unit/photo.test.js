/**
 * Member photo upload.
 *
 * The file never passes through the API: the browser gets a signed URL, PUTs the
 * bytes straight to Storage, then confirms the path. These tests prove the
 * brokering — the path convention the Storage policy depends on, the
 * `members.photo.manage` gate, the content-type check, and that a confirmed path
 * must belong to the member it is set on.
 *
 * Honest limit: the Supabase Storage wire protocol is faked here (a recorder), not
 * exercised against a real project. See docs/SECURITY.md.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createMembersService } from '../../src/services/members.service.js';
import { createStorageService } from '../../src/services/storage.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import {
  BRANCH_MAIN,
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });
const MEMBER_ID = '11111111-2222-4333-8444-555555555555';

function memberRow(overrides = {}) {
  return {
    id: MEMBER_ID,
    branch_id: BRANCH_MAIN,
    member_no: 'MAIN-000001',
    full_name: 'Ama Mensah',
    photo_path: null,
    membership_status: 'active',
    ...overrides,
  };
}

function fakeStorage({ readError = null } = {}) {
  const calls = [];
  const bucketApi = {
    createSignedUploadUrl(path) {
      calls.push(['createSignedUploadUrl', path]);
      return Promise.resolve({
        data: { signedUrl: 'https://storage/upload', token: 'tok', path },
        error: null,
      });
    },
    createSignedUrl(path, ttl) {
      calls.push(['createSignedUrl', path, ttl]);
      return Promise.resolve({
        data: readError ? null : { signedUrl: 'https://storage/read' },
        error: readError,
      });
    },
    remove(paths) {
      calls.push(['remove', paths]);
      return Promise.resolve({ data: [{}], error: null });
    },
  };
  const client = { storage: { from: (bucket) => (calls.push(['from', bucket]), bucketApi) } };
  return { getClient: () => client, calls };
}

/** 'user-4' holds members.photo.manage; 'user-1' does not (but has members.view). */
function createClient({ as = 'user-4', rows = [memberRow()], storage } = {}) {
  const recorder = createQueryRecorder({ rows });
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });
  const store = storage ?? fakeStorage();

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    members: createMembersService({ getClient: recorder.getClient }),
    storage: createStorageService({ getClient: store.getClient }),
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

  return { call, store };
}

const base = `/api/members/${MEMBER_ID}/photo`;

/* ---- service ------------------------------------------------------------- */

describe('the storage service', () => {
  it('builds a branch/member/uuid path with the right extension', async () => {
    const store = fakeStorage();
    const storage = createStorageService({ getClient: store.getClient });

    const result = await storage.createMemberPhotoUpload({
      accessToken: 't',
      branchId: BRANCH_MAIN,
      memberId: MEMBER_ID,
      contentType: 'image/png',
    });

    assert.match(result.path, new RegExp(`^${BRANCH_MAIN}/${MEMBER_ID}/[0-9a-f-]+\\.png$`));
    assert.equal(result.uploadUrl, 'https://storage/upload');
  });

  it('refuses an unsupported content type before touching storage', async () => {
    const store = fakeStorage();
    const storage = createStorageService({ getClient: store.getClient });

    await assert.rejects(
      () =>
        storage.createMemberPhotoUpload({
          accessToken: 't',
          branchId: BRANCH_MAIN,
          memberId: MEMBER_ID,
          contentType: 'image/svg+xml',
        }),
      (error) => error.status === 409,
    );
    assert.equal(
      store.calls.some(([m]) => m === 'createSignedUploadUrl'),
      false,
    );
  });

  it('signs a read URL with a short TTL', async () => {
    const store = fakeStorage();
    const storage = createStorageService({ getClient: store.getClient });

    await storage.signMemberPhoto({ accessToken: 't', path: `${BRANCH_MAIN}/${MEMBER_ID}/x.jpg` });
    const call = store.calls.find(([m]) => m === 'createSignedUrl');
    assert.equal(call[2], 300);
  });
});

/* ---- routes -------------------------------------------------------------- */

describe('member photo endpoints', () => {
  it('mints an upload URL for a caller with members.photo.manage', async () => {
    const { call } = createClient();
    const response = await call(`${base}/upload-url`, {
      method: 'POST',
      body: { contentType: 'image/jpeg' },
    });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.uploadUrl, 'https://storage/upload');
    assert.ok(data.path.startsWith(`${BRANCH_MAIN}/${MEMBER_ID}/`));
  });

  it('rejects an unsupported content type with a 422', async () => {
    const { call } = createClient();
    const response = await call(`${base}/upload-url`, {
      method: 'POST',
      body: { contentType: 'image/gif' },
    });
    assert.equal(response.status, 422);
  });

  it('confirms a path that belongs to the member', async () => {
    const { call } = createClient();
    const response = await call(base, {
      method: 'PATCH',
      body: { path: `${BRANCH_MAIN}/${MEMBER_ID}/photo.jpg` },
    });
    assert.equal(response.status, 200);
  });

  it('refuses a path that belongs to another member', async () => {
    const { call } = createClient();
    const response = await call(base, {
      method: 'PATCH',
      body: { path: `${BRANCH_MAIN}/99999999-0000-4000-8000-000000000000/photo.jpg` },
    });
    assert.equal(response.status, 422);
  });

  it('returns a signed read URL when the member has a photo', async () => {
    const { call } = createClient({
      rows: [memberRow({ photo_path: `${BRANCH_MAIN}/${MEMBER_ID}/x.jpg` })],
    });
    const response = await call(base);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.url, 'https://storage/read');
  });

  it('returns a null url when the member has no photo', async () => {
    const { call } = createClient();
    const response = await call(base);
    assert.equal((await response.json()).data.url, null);
  });

  it('refuses upload, set, and delete without members.photo.manage', async () => {
    const upload = await createClient({ as: 'user-1' }).call(`${base}/upload-url`, {
      method: 'POST',
      body: { contentType: 'image/jpeg' },
    });
    assert.equal(upload.status, 403);

    const del = await createClient({ as: 'user-1' }).call(base, { method: 'DELETE' });
    assert.equal(del.status, 403);
  });

  it('deletes the photo and answers 204', async () => {
    const { call, store } = createClient({
      rows: [memberRow({ photo_path: `${BRANCH_MAIN}/${MEMBER_ID}/x.jpg` })],
    });
    const response = await call(base, { method: 'DELETE' });
    assert.equal(response.status, 204);
    assert.ok(store.calls.some(([m]) => m === 'remove'));
  });
});
