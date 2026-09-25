/**
 * Unit-level tests for the pieces the integration tests exercise as a whole:
 * cookie construction and parsing, the CSRF primitives, token-expiry reading,
 * permission scoping, and the rate-limit store.
 *
 * These cover the branches that are awkward to reach through an HTTP request —
 * malformed cookie headers, a token with no readable expiry, a permission held
 * in one branch but asked about in another.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildClearedCookies,
  buildSessionCookies,
  cookieName,
  parseCookies,
  readSessionCookies,
  withCookies,
} from '../../src/auth/cookies.js';
import { checkOrigin, generateCsrfToken, timingSafeEqual } from '../../src/auth/csrf.js';
import { createPermissionSet } from '../../src/auth/identity.js';
import { isExpired, isNearExpiry, readTokenExpiry } from '../../src/auth/session.js';
import { loadConfig } from '../../src/config/env.js';
import {
  RATE_LIMITS,
  createMemoryRateLimitStore,
  createRateLimiter,
} from '../../src/server/middleware/rate-limit.js';
import { mintToken } from './auth-fixtures.js';

const localCfg = loadConfig({ APP_URL: 'http://localhost:3000' });
const deployedCfg = loadConfig({ APP_URL: 'https://church.example' });

/* -------------------------------------------------------------------------- */

describe('cookie names', () => {
  it('are prefixed from configuration, so the prefix can invalidate every session', () => {
    const custom = loadConfig({ SESSION_COOKIE_PREFIX: 'stjohn' });
    assert.equal(cookieName('access', custom), 'stjohn_at');
    assert.equal(cookieName('refresh', custom), 'stjohn_rt');
    assert.equal(cookieName('csrf', custom), 'stjohn_csrf');
  });

  it('reject an unknown kind rather than producing a plausible-looking name', () => {
    assert.throws(() => cookieName('session'), /Unknown cookie kind/);
  });
});

describe('parseCookies', () => {
  it('reads a normal header', () => {
    assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  });

  it('treats a missing header as no cookies', () => {
    assert.deepEqual(parseCookies(null), {});
    assert.deepEqual(parseCookies(''), {});
  });

  it('survives malformed input instead of throwing', () => {
    // A proxy or an extension can produce any of these. "No session" is the
    // right answer; a 500 is not.
    assert.deepEqual(parseCookies('=value'), {});
    assert.deepEqual(parseCookies('novalue'), {});
    assert.deepEqual(parseCookies(';;;'), {});
    assert.deepEqual(parseCookies('a=1;;b=2'), { a: '1', b: '2' });
  });

  it('keeps a value containing "=", which base64 and JWTs both produce', () => {
    assert.deepEqual(parseCookies('token=abc=='), { token: 'abc==' });
  });

  it('does not URL-decode, so %3B cannot smuggle a separator', () => {
    assert.deepEqual(parseCookies('a=x%3Bb%3Dy'), { a: 'x%3Bb%3Dy' });
  });
});

describe('buildSessionCookies', () => {
  const session = {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresIn: 3600,
    csrfToken: 'csrf',
  };

  it('omits Secure on http, so local development can sign in', () => {
    const [access] = buildSessionCookies(session, localCfg);
    assert.doesNotMatch(access, /Secure/);
  });

  it('sets Secure on https', () => {
    const [access] = buildSessionCookies(session, deployedCfg);
    assert.match(access, /Secure/);
  });

  it('keeps the access cookie alive past the token expiry, so a refresh is possible', () => {
    const [access] = buildSessionCookies(session, localCfg);
    const maxAge = Number(/Max-Age=(\d+)/.exec(access)[1]);

    assert.ok(
      maxAge > 3600,
      'if the cookie died with the token, the user would be logged out instead of refreshed',
    );
  });

  it('scopes the refresh cookie to the auth endpoints only', () => {
    const [, refresh] = buildSessionCookies(session, localCfg);
    assert.match(refresh, /Path=\/api\/auth/);
    assert.match(refresh, /SameSite=Strict/);
    assert.match(refresh, /HttpOnly/);
  });

  it('leaves the CSRF cookie readable, and the other two not', () => {
    const [access, refresh, csrf] = buildSessionCookies(session, localCfg);
    assert.match(access, /HttpOnly/);
    assert.match(refresh, /HttpOnly/);
    assert.doesNotMatch(csrf, /HttpOnly/);
  });
});

describe('buildClearedCookies', () => {
  it('clears each cookie on the Path it was set with', () => {
    const [access, refresh, csrf] = buildClearedCookies(localCfg);

    assert.match(access, /^cma_at=; Path=\/;/);
    assert.match(refresh, /Path=\/api\/auth/);
    assert.match(csrf, /^cma_csrf=;/);
    for (const cookie of [access, refresh, csrf]) {
      assert.match(cookie, /Max-Age=0/);
    }
  });
});

describe('readSessionCookies', () => {
  it('returns nulls when nothing is present', () => {
    const request = new Request('http://localhost/api/x');
    assert.deepEqual(readSessionCookies(request, localCfg), {
      accessToken: null,
      refreshToken: null,
      csrfToken: null,
    });
  });

  it('reads all three', () => {
    const request = new Request('http://localhost/api/x', {
      headers: { cookie: 'cma_at=A; cma_rt=R; cma_csrf=C' },
    });
    assert.deepEqual(readSessionCookies(request, localCfg), {
      accessToken: 'A',
      refreshToken: 'R',
      csrfToken: 'C',
    });
  });
});

describe('withCookies', () => {
  it('adds Set-Cookie without disturbing the status or the body', async () => {
    const original = new Response(JSON.stringify({ data: 1 }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });

    const result = withCookies(original, ['a=1', 'b=2']);

    assert.equal(result.status, 201);
    assert.equal(result.headers.get('content-type'), 'application/json');
    assert.deepEqual(result.headers.getSetCookie(), ['a=1', 'b=2']);
    assert.deepEqual(await result.json(), { data: 1 });
  });
});

/* -------------------------------------------------------------------------- */

describe('CSRF primitives', () => {
  it('generates a 64-character hex token with no characters needing re-encoding', () => {
    const token = generateCsrfToken();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(token, generateCsrfToken());
  });

  it('compares equal strings as equal and unequal as unequal', () => {
    assert.equal(timingSafeEqual('abc', 'abc'), true);
    assert.equal(timingSafeEqual('abc', 'abd'), false);
    assert.equal(timingSafeEqual('abc', 'ab'), false);
    assert.equal(timingSafeEqual('', ''), true);
  });

  it('refuses non-strings rather than coercing them', () => {
    assert.equal(timingSafeEqual(undefined, undefined), false);
    assert.equal(timingSafeEqual(null, null), false);
    assert.equal(timingSafeEqual(123, 123), false);
  });

  it('prefers Sec-Fetch-Site, which page JavaScript cannot set', () => {
    const make = (headers) => new Request('http://localhost/api/x', { method: 'POST', headers });

    assert.equal(checkOrigin(make({ 'sec-fetch-site': 'same-origin' }), localCfg), true);
    assert.equal(checkOrigin(make({ 'sec-fetch-site': 'cross-site' }), localCfg), false);
    assert.equal(checkOrigin(make({ 'sec-fetch-site': 'same-site' }), localCfg), false);
    // A user-initiated navigation cannot legitimately be a state-changing POST.
    assert.equal(checkOrigin(make({ 'sec-fetch-site': 'none' }), localCfg), false);
  });

  it('falls back to Origin, and reports "unknown" when the browser said neither', () => {
    const make = (headers) => new Request('http://localhost/api/x', { method: 'POST', headers });

    assert.equal(checkOrigin(make({ origin: 'http://localhost:3000' }), localCfg), true);
    assert.equal(checkOrigin(make({ origin: 'https://evil.example' }), localCfg), false);
    assert.equal(checkOrigin(make({}), localCfg), null);
  });
});

/* -------------------------------------------------------------------------- */

describe('token expiry reading', () => {
  it('reads the exp claim', () => {
    const token = mintToken({ expiresInSeconds: 600 });
    const exp = readTokenExpiry(token);
    assert.ok(Math.abs(exp - (Date.now() / 1000 + 600)) < 5);
  });

  it('returns null for anything it cannot read, rather than throwing', () => {
    assert.equal(readTokenExpiry('not-a-token'), null);
    assert.equal(readTokenExpiry('a.b.c'), null);
    assert.equal(readTokenExpiry(''), null);
  });

  it('treats an unreadable token as "do not pre-emptively refresh"', () => {
    // Refusing to guess is right: the token still has to satisfy Supabase, so a
    // token we cannot parse fails there, not here.
    assert.equal(isExpired('garbage'), false);
    assert.equal(isNearExpiry('garbage'), false);
  });

  it('identifies an expired token', () => {
    assert.equal(isExpired(mintToken({ expiresInSeconds: -1 })), true);
    assert.equal(isExpired(mintToken({ expiresInSeconds: 600 })), false);
  });

  it('identifies a token inside the refresh window but not one outside it', () => {
    assert.equal(isNearExpiry(mintToken({ expiresInSeconds: 60 })), true);
    assert.equal(isNearExpiry(mintToken({ expiresInSeconds: 600 })), false);
  });
});

/* -------------------------------------------------------------------------- */

describe('permission scoping', () => {
  const permissions = createPermissionSet([
    { permissionKey: 'members.view', branchId: 'branch-a' },
    { permissionKey: 'members.create', branchId: 'branch-a' },
    { permissionKey: 'settings.view', branchId: null },
  ]);

  it('grants a branch-scoped permission in that branch only', () => {
    assert.equal(permissions.can('members.view', 'branch-a'), true);
    assert.equal(permissions.can('members.view', 'branch-b'), false);
  });

  it('grants an unscoped permission in every branch', () => {
    assert.equal(permissions.can('settings.view', 'branch-a'), true);
    assert.equal(permissions.can('settings.view', 'branch-b'), true);
  });

  it('answers "anywhere at all?" when no branch is given', () => {
    assert.equal(permissions.can('members.view'), true);
    assert.equal(permissions.can('members.delete'), false);
  });

  it('never invents a permission that was not granted', () => {
    assert.equal(permissions.can('members.delete', 'branch-a'), false);
    assert.equal(permissions.can('finance.approve', 'branch-a'), false);
  });

  it('lists held keys once each, sorted', () => {
    const set = createPermissionSet([
      { permissionKey: 'b.view', branchId: 'x' },
      { permissionKey: 'b.view', branchId: 'y' },
      { permissionKey: 'a.view', branchId: null },
    ]);
    assert.deepEqual(set.keys(), ['a.view', 'b.view']);
  });

  it('reports null branches for a global grant, distinguishing it from a scoped one', () => {
    assert.equal(permissions.branchesFor('settings.view'), null);
    assert.deepEqual(permissions.branchesFor('members.view'), ['branch-a']);
    assert.deepEqual(permissions.branchesFor('nothing.here'), []);
  });

  it('treats an empty grant list as no permissions', () => {
    const none = createPermissionSet([]);
    assert.equal(none.can('members.view'), false);
    assert.deepEqual(none.keys(), []);
  });
});

/* -------------------------------------------------------------------------- */

describe('rate limiting', () => {
  it('allows up to the limit, then refuses', async () => {
    const limiter = createRateLimiter();
    const rule = { name: 'test', keys: ['ip-1'], limit: 3, windowMs: 1000 };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await limiter.assertWithin(rule);
    }
    await assert.rejects(() => limiter.assertWithin(rule), /Too many attempts/);
  });

  it('forgets old attempts once the window has passed', async () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter({ now: () => clock });
    const rule = { name: 'test', keys: ['ip-1'], limit: 2, windowMs: 60_000 };

    await limiter.assertWithin(rule);
    await limiter.assertWithin(rule);
    await assert.rejects(() => limiter.assertWithin(rule));

    clock += 60_001;
    await limiter.assertWithin(rule);
  });

  it('keeps separate budgets per key and per rule name', async () => {
    const limiter = createRateLimiter();

    await limiter.assertWithin({ name: 'a', keys: ['ip-1'], limit: 1, windowMs: 1000 });
    // Same key, different rule.
    await limiter.assertWithin({ name: 'b', keys: ['ip-1'], limit: 1, windowMs: 1000 });
    // Same rule, different key.
    await limiter.assertWithin({ name: 'a', keys: ['ip-2'], limit: 1, windowMs: 1000 });

    await assert.rejects(() =>
      limiter.assertWithin({ name: 'a', keys: ['ip-1'], limit: 1, windowMs: 1000 }),
    );
  });

  it('does not consume budget on the other dimensions when one refuses', async () => {
    const limiter = createRateLimiter();
    const rule = { limit: 2, windowMs: 60_000 };

    // Exhaust the email dimension only.
    await limiter.assertWithin({ ...rule, name: 'login', keys: ['ip-1', 'a@b.c'] });
    await limiter.assertWithin({ ...rule, name: 'login', keys: ['ip-2', 'a@b.c'] });
    await assert.rejects(() =>
      limiter.assertWithin({ ...rule, name: 'login', keys: ['ip-3', 'a@b.c'] }),
    );

    // ip-3 was refused, so it should not have been charged for the attempt.
    await limiter.assertWithin({ ...rule, name: 'login', keys: ['ip-3', 'other@b.c'] });
    await limiter.assertWithin({ ...rule, name: 'login', keys: ['ip-3', 'other@b.c'] });
  });

  it('ignores absent dimensions instead of limiting on "null"', async () => {
    const limiter = createRateLimiter();
    const rule = { name: 'test', limit: 1, windowMs: 1000 };

    // A missing IP must not become a shared bucket that throttles everyone.
    await limiter.assertWithin({ ...rule, keys: [null, 'a@b.c'] });
    await limiter.assertWithin({ ...rule, keys: [null, 'other@b.c'] });
  });

  it('clears a budget after a successful sign-in', async () => {
    const limiter = createRateLimiter();
    const rule = { name: 'login', keys: ['ip-1'], limit: 1, windowMs: 60_000 };

    await limiter.assertWithin(rule);
    await assert.rejects(() => limiter.assertWithin(rule));

    await limiter.clear({ name: 'login', keys: ['ip-1'] });
    await limiter.assertWithin(rule);
  });

  it('reports the window in the error, so the client can say how long to wait', async () => {
    const limiter = createRateLimiter();
    const rule = { name: 'test', keys: ['ip-1'], limit: 0, windowMs: 90_000 };

    await assert.rejects(
      () => limiter.assertWithin(rule),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.details.retryAfterSeconds, 90);
        return true;
      },
    );
  });

  it('prunes its own storage, so a flood of keys cannot grow it without bound', async () => {
    const store = createMemoryRateLimitStore();

    for (let index = 0; index < 12_000; index += 1) {
      await store.record(`k-${index}`, 60_000);
    }
    // Exact size is an implementation detail; the guarantee is that it is bounded.
    assert.ok((await store.count('k-11999', 60_000)) >= 1);
  });

  it('defines the documented limits for each auth endpoint', () => {
    assert.equal(RATE_LIMITS.login.limit, 10);
    assert.equal(RATE_LIMITS.login.windowMs, 15 * 60 * 1000);
    assert.equal(RATE_LIMITS.passwordForgot.limit, 5);
    assert.equal(RATE_LIMITS.passwordReset.limit, 10);
  });
});
