import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getRouteTable, handleRequest, resolvePath } from '../../src/server/app.js';

/** Silence log output during tests; assert on responses instead. */
const silent = { sink: () => {} };

const call = (path, options = {}) =>
  handleRequest(new Request(`http://localhost${path}`, options), silent);

describe('resolvePath', () => {
  it('strips the /api prefix', () => {
    assert.equal(resolvePath('http://x/api/health'), '/health');
    assert.equal(resolvePath('http://x/api/members/123'), '/members/123');
  });

  it('maps /api and /api/ to the root', () => {
    assert.equal(resolvePath('http://x/api'), '/');
    assert.equal(resolvePath('http://x/api/'), '/');
  });

  it('falls back to the ?path= capture when the rewrite lands on the entrypoint', () => {
    assert.equal(resolvePath('http://x/api/index?path=health'), '/health');
    assert.equal(resolvePath('http://x/api/index?path=/members/9'), '/members/9');
  });

  it('prefers the pathname, so a client cannot spoof a route with ?path=', () => {
    assert.equal(resolvePath('http://x/api/health?path=admin/users'), '/health');
  });

  it('drops trailing slashes but keeps the root', () => {
    assert.equal(resolvePath('http://x/api/members/'), '/members');
    assert.equal(resolvePath('http://x/'), '/');
  });
});

describe('route table', () => {
  it('names every registered endpoint, so a new one cannot appear unnoticed', () => {
    const signatures = getRouteTable()
      .map((route) => `${route.method} ${route.pattern}`)
      .sort();

    assert.deepEqual(signatures, [
      'DELETE /admin/notifications/:id',
      'DELETE /admin/roles/:id',
      'DELETE /admin/users/:id/roles/:grantId',
      'DELETE /attendance/sessions/:id',
      'DELETE /attendance/sessions/:id/records/:recordId',
      'DELETE /events/:id',
      'DELETE /events/:id/registrations/:registrationId',
      'DELETE /families/:id',
      'DELETE /families/:id/members/:memberId',
      'DELETE /members/:id',
      'DELETE /members/:id/emergency-contacts/:contactId',
      'DELETE /members/:id/photo',
      'DELETE /members/:id/spiritual-gifts/:giftId',
      'DELETE /ministries/:id',
      'GET /admin/audit',
      'GET /admin/notifications',
      'GET /admin/notifications/:id',
      'GET /admin/notifications/audiences',
      'GET /admin/roles',
      'GET /admin/roles/:id',
      'GET /admin/roles/permissions',
      'GET /admin/settings',
      'GET /admin/users',
      'GET /admin/users/:id',
      'GET /admin/users/roles',
      'GET /attendance/sessions',
      'GET /attendance/sessions/:id',
      'GET /auth/session',
      'GET /event-categories',
      'GET /events',
      'GET /events/:id',
      'GET /events/:id/registrations',
      'GET /families',
      'GET /families/:id',
      'GET /health',
      'GET /health/deep',
      'GET /members',
      'GET /members/:id',
      'GET /members/:id/attendance',
      'GET /members/:id/emergency-contacts',
      'GET /members/:id/photo',
      'GET /members/:id/spiritual-gifts',
      'GET /members/directory',
      'GET /ministries',
      'GET /ministries/:id',
      'GET /notifications',
      'GET /notifications/unread-count',
      'GET /reports/attendance/export',
      'GET /reports/attendance/summary',
      'GET /reports/events/export',
      'GET /reports/events/summary',
      'GET /reports/finance/export',
      'GET /reports/finance/summary',
      'GET /reports/members/export',
      'GET /reports/members/summary',
      'GET /reports/ministries/export',
      'GET /reports/ministries/summary',
      'GET /spiritual-gifts',
      'GET /transaction-categories',
      'GET /transactions',
      'GET /transactions/:id',
      'PATCH /admin/roles/:id',
      'PATCH /admin/settings/:key',
      'PATCH /admin/users/:id',
      'PATCH /attendance/sessions/:id',
      'PATCH /attendance/sessions/:id/records/:recordId',
      'PATCH /events/:id',
      'PATCH /events/:id/registrations/:registrationId',
      'PATCH /families/:id',
      'PATCH /families/:id/members/:memberId',
      'PATCH /members/:id',
      'PATCH /members/:id/emergency-contacts/:contactId',
      'PATCH /members/:id/photo',
      'PATCH /ministries/:id',
      'PATCH /ministries/:id/members/:memberId',
      'PATCH /spiritual-gifts/:id',
      'PATCH /transaction-categories/:id',
      'PATCH /transactions/:id',
      'POST /admin/notifications',
      'POST /admin/roles',
      'POST /admin/users',
      'POST /admin/users/:id/active',
      'POST /admin/users/:id/roles',
      'POST /attendance/sessions',
      'POST /attendance/sessions/:id/records',
      'POST /auth/login',
      'POST /auth/logout',
      'POST /auth/password/forgot',
      'POST /auth/password/reset',
      'POST /events',
      'POST /events/:id/registrations',
      'POST /events/:id/status',
      'POST /families',
      'POST /families/:id/members',
      'POST /members',
      'POST /members/:id/emergency-contacts',
      'POST /members/:id/photo/upload-url',
      'POST /members/:id/restore',
      'POST /members/:id/spiritual-gifts',
      'POST /ministries',
      'POST /ministries/:id/members',
      'POST /notifications/:id/read',
      'POST /notifications/read-all',
      'POST /spiritual-gifts',
      'POST /transaction-categories',
      'POST /transactions',
      'POST /transactions/:id/status',
      'PUT /admin/roles/:id/permissions',
    ]);
  });

  it('gives every route exactly one access decision', () => {
    for (const route of getRouteTable()) {
      assert.ok(
        route.isPublic || route.permission,
        `${route.method} ${route.pattern} has no access decision`,
      );
      assert.ok(
        !(route.isPublic && route.permission),
        `${route.method} ${route.pattern} is both public and guarded`,
      );
    }
  });

  it('routes the literal /members/directory before the /members/:id parameter', () => {
    const patterns = getRouteTable().map((route) => route.pattern);
    assert.ok(patterns.indexOf('/members/directory') < patterns.indexOf('/members/:id'));
  });

  it('answers 405 before 401 for a wrong method, which reveals the route table and nothing else', async () => {
    // Method matching happens before the guards run, so an anonymous caller
    // learns that POST /api/families/:id/members exists. The API surface is
    // documented in README.md, so this is accepted rather than worked around —
    // recorded here so it stays a decision rather than becoming a surprise.
    const response = await call('/api/families/abc/members');
    assert.equal(response.status, 405);

    const { error } = await response.json();
    assert.deepEqual(error.details, { allowed: ['POST'] });
  });

  it('marks only the session-establishing routes and liveness as public', () => {
    const publicPatterns = getRouteTable()
      .filter((route) => route.isPublic)
      .map((route) => route.pattern)
      .sort();

    assert.deepEqual(publicPatterns, [
      '/auth/login',
      '/auth/logout',
      '/auth/password/forgot',
      '/auth/password/reset',
      '/auth/session',
      '/health',
    ]);
  });
});

describe('GET /api/health', () => {
  it('returns 200 with the service descriptor', async () => {
    const response = await call('/api/health');
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.equal(payload.data.status, 'ok');
    assert.equal(payload.data.service, 'church-management-system');
    assert.equal(typeof payload.data.version, 'string');
    assert.equal(typeof payload.data.supabase.configured, 'boolean');
  });

  it('never caches, and carries the security headers', async () => {
    const response = await call('/api/health');
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-type'), /application\/json/);
  });

  it('routes correctly when the rewrite passes the path as a query capture', async () => {
    const response = await call('/api/index?path=health');
    assert.equal(response.status, 200);
  });

  it('answers HEAD with no body', async () => {
    const response = await call('/api/health', { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  });

  it('does not expose the deep probe on the public route', async () => {
    const response = await call('/api/health');
    const payload = await response.json();
    assert.equal(payload.data.supabase.reachable, undefined);
  });

  it('refuses the deep probe without a session', async () => {
    const response = await call('/api/health/deep');
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHENTICATED');
  });
});

describe('error responses', () => {
  it('returns a 404 envelope for an unknown endpoint', async () => {
    const response = await call('/api/does-not-exist');
    assert.equal(response.status, 404);

    const payload = await response.json();
    assert.equal(payload.error.code, 'NOT_FOUND');
    assert.equal(typeof payload.error.requestId, 'string');
    assert.equal(payload.data, undefined);
  });

  it('returns 405 with the allowed methods for a wrong method', async () => {
    const response = await call('/api/health', { method: 'POST' });
    assert.equal(response.status, 405);

    const payload = await response.json();
    assert.equal(payload.error.code, 'METHOD_NOT_ALLOWED');
    assert.deepEqual(payload.error.details, { allowed: ['GET'] });
  });

  it('leaks nothing diagnostic in an error body', async () => {
    const response = await call('/api/does-not-exist');
    const body = await response.text();
    assert.doesNotMatch(body, /at .*\.js:\d+/); // no stack frames
    assert.doesNotMatch(body, /[A-Z]:\\|\/home\//); // no filesystem paths
    assert.deepEqual(Object.keys(JSON.parse(body).error).sort(), ['code', 'message', 'requestId']);
  });

  it('honours an upstream x-vercel-id as the request id', async () => {
    const response = await handleRequest(
      new Request('http://localhost/api/does-not-exist', {
        headers: { 'x-vercel-id': 'iad1::abc123' },
      }),
      silent,
    );
    const payload = await response.json();
    assert.equal(payload.error.requestId, 'iad1::abc123');
  });
});

describe('request logging', () => {
  it('writes one structured line per request, carrying the request id', async () => {
    const lines = [];
    await handleRequest(new Request('http://localhost/api/health'), {
      sink: (line) => lines.push(line),
    });

    const parsed = lines.map((line) => JSON.parse(line));
    const requestLine = parsed.find((line) => line.message === 'request');

    assert.ok(requestLine, 'expected a "request" log line');
    assert.equal(requestLine.status, 200);
    assert.equal(requestLine.path, '/health');
    assert.equal(typeof requestLine.requestId, 'string');
    assert.equal(typeof requestLine.durationMs, 'number');
  });
});
