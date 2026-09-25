import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRouter } from '../../src/server/router.js';

const noop = () => new Response(null, { status: 204 });
const guards = {
  requireSession: () => undefined,
  requirePermission: (permission) => () => ({ permission }),
};

describe('router: deny by default', () => {
  it('refuses a route that declares neither public nor a permission', () => {
    const router = createRouter();
    assert.throws(() => router.get('/members', noop), /neither "public: true" nor a "permission"/);
  });

  it('refuses a route that is both public and permission-guarded', () => {
    const router = createRouter({ guards });
    assert.throws(
      () => router.get('/members', noop, { public: true, permission: 'members.view' }),
      /pick one/,
    );
  });

  it('refuses a permissioned route when the guards are not wired in', () => {
    const router = createRouter();
    assert.throws(
      () => router.get('/members', noop, { permission: 'members.view' }),
      /without session\/permission guards/,
    );
  });

  it('accepts a permissioned route once the guards exist', () => {
    const router = createRouter({ guards });
    router.get('/members', noop, { permission: 'members.view' });
    assert.deepEqual(router.list(), [
      {
        method: 'GET',
        pattern: '/members',
        permission: 'members.view',
        guard: 'permission',
        isPublic: false,
      },
    ]);
  });

  it('refuses the leadership guard when the router was not given one', () => {
    const router = createRouter({ guards });
    assert.throws(
      () =>
        router.patch('/ministries/:id', noop, {
          permission: 'ministries.update',
          guard: 'permissionOrLeadership',
        }),
      /leadership guard/,
    );
  });

  it('records which guard kind a route uses, so the choice is inspectable', () => {
    const router = createRouter({
      guards: { ...guards, requirePermissionOrLeadership: () => () => undefined },
    });
    router.patch('/ministries/:id', noop, {
      permission: 'ministries.update',
      guard: 'permissionOrLeadership',
    });

    assert.equal(router.list()[0].guard, 'permissionOrLeadership');
  });

  it('refuses a route with no handler', () => {
    const router = createRouter();
    assert.throws(() => router.get('/members', undefined, { public: true }), /no handler function/);
  });
});

describe('router: matching', () => {
  it('matches a static path', () => {
    const router = createRouter();
    router.get('/health', noop, { public: true });

    const matched = router.match('GET', '/health');
    assert.equal(matched.route.pattern, '/health');
    assert.deepEqual(matched.params, {});
  });

  it('extracts and decodes parameters', () => {
    const router = createRouter();
    router.get('/members/:id/attendance', noop, { public: true });

    const matched = router.match('GET', '/members/a%20b/attendance');
    assert.deepEqual(matched.params, { id: 'a b' });
  });

  it('does not let a parameter swallow a path separator', () => {
    const router = createRouter();
    router.get('/members/:id', noop, { public: true });

    assert.equal(router.match('GET', '/members/123/extra'), null);
  });

  it('returns null for an unknown path', () => {
    const router = createRouter();
    router.get('/health', noop, { public: true });

    assert.equal(router.match('GET', '/nope'), null);
  });

  it('throws 405 with an Allow list when the path matches but the method does not', () => {
    const router = createRouter();
    router.get('/members', noop, { public: true });
    router.post('/members', noop, { public: true });

    assert.throws(
      () => router.match('DELETE', '/members'),
      (error) => {
        assert.equal(error.status, 405);
        assert.deepEqual(error.details, { allowed: ['GET', 'POST'] });
        return true;
      },
    );
  });

  it('treats HEAD as GET', () => {
    const router = createRouter();
    router.get('/health', noop, { public: true });

    assert.equal(router.match('HEAD', '/health').route.method, 'GET');
  });

  it('builds the guard chain in order: session, then permission', () => {
    const router = createRouter({ guards });
    router.post('/members', noop, { permission: 'members.create' });

    const { route } = router.match('POST', '/members');
    assert.equal(route.guards.length, 2);
    assert.deepEqual(route.guards[1](), { permission: 'members.create' });
  });

  it('rejects a malformed pattern at registration', () => {
    const router = createRouter();
    assert.throws(() => router.get('members', noop, { public: true }), /must start with "\/"/);
    assert.throws(() => router.get('/members/id:x', noop, { public: true }), /Malformed parameter/);
  });
});
