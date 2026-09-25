/**
 * The authentication surface, end to end.
 *
 * These tests drive `handleRequest` — the real router, guards, cookie code, CSRF
 * check, rate limiter, validation, and error mapping — with only GoTrue replaced
 * by a fake. A small cookie jar makes the client behave like a browser, so the
 * cookie flags and rotation are exercised rather than asserted about in theory.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import {
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });

/**
 * A test client with a cookie jar.
 *
 * `csrf: true` echoes the cma_csrf cookie into the header, which is what the
 * real frontend does. Tests that omit it are testing the CSRF check.
 */
function createClient({
  accounts = FIXTURES.accounts,
  profiles = FIXTURES.profiles,
  ...rest
} = {}) {
  const { provider, calls } = createFakeProvider({ accounts, ...rest });
  const loadIdentity = createFakeIdentityLoader(profiles);
  const rateLimiter = createRateLimiter();
  const router = buildRouter({ cfg, provider, loadIdentity, rateLimiter });

  /** name -> value; a value of '' means the server cleared it. */
  const jar = new Map();

  function applySetCookies(response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  function cookieHeader() {
    const live = [...jar.entries()].filter(([, value]) => value !== '');
    return live.map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async function call(path, { method = 'GET', body, csrf = true, headers = {}, origin } = {}) {
    const requestHeaders = { 'sec-fetch-site': 'same-origin', ...headers };

    // A null value removes a default — used to simulate a browser that sent no
    // Sec-Fetch-Site, so the Origin check is the one that decides.
    for (const [name, value] of Object.entries(requestHeaders)) {
      if (value === null) delete requestHeaders[name];
    }

    if (origin !== undefined) requestHeaders.origin = origin;
    if (body !== undefined) requestHeaders['content-type'] = 'application/json';

    const cookies = cookieHeader();
    if (cookies) requestHeaders.cookie = cookies;

    if (csrf && jar.get('cma_csrf')) requestHeaders['x-csrf-token'] = jar.get('cma_csrf');

    const response = await handleRequest(
      new Request(`http://localhost:3000${path}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { router, sink: () => {} },
    );

    applySetCookies(response);
    return response;
  }

  const login = (email, password = 'correct-horse-battery') =>
    call('/api/auth/login', { method: 'POST', body: { email, password } });

  return { call, login, calls, jar, cookies: () => Object.fromEntries(jar) };
}

/** Set-Cookie attributes for one cookie, as a lowercase set. */
function attributesOf(response, name) {
  const cookie = response.headers.getSetCookie().find((item) => item.startsWith(`${name}=`));
  assert.ok(cookie, `no Set-Cookie for ${name}`);
  return {
    raw: cookie,
    flags: new Set(
      cookie
        .split(';')
        .slice(1)
        .map((part) => part.trim().toLowerCase()),
    ),
  };
}

/* -------------------------------------------------------------------------- */

describe('POST /api/auth/login', () => {
  it('signs in a valid user and returns their permissions', async () => {
    const client = createClient();
    const response = await client.login('secretary@church.test');

    assert.equal(response.status, 200);
    const { data } = await response.json();

    assert.equal(data.user.id, 'user-1');
    assert.equal(data.user.email, 'secretary@church.test');
    assert.equal(data.user.fullName, 'Ama Secretary');
    assert.deepEqual(data.permissions, [
      'families.create',
      'families.update',
      'families.view',
      'members.create',
      'members.update',
      'members.view',
      'settings.view',
    ]);
  });

  it('returns no token of any kind in the body', async () => {
    const client = createClient();
    const response = await client.login('secretary@church.test');
    const body = await response.text();

    assert.doesNotMatch(body, /accessToken|access_token|refreshToken|refresh_token/);
    // The minted JWT's header, which would appear if a token leaked into the body.
    assert.doesNotMatch(body, /eyJ/);
  });

  it('sets the session cookies with the flags that make them safe', async () => {
    const client = createClient();
    const response = await client.login('secretary@church.test');

    const access = attributesOf(response, 'cma_at');
    assert.ok(access.flags.has('httponly'), 'the access token must be unreadable by JS');
    assert.ok(access.flags.has('samesite=lax'));
    assert.ok(access.flags.has('path=/'));

    const refresh = attributesOf(response, 'cma_rt');
    assert.ok(refresh.flags.has('httponly'));
    assert.ok(refresh.flags.has('samesite=strict'), 'the refresh token gets the stricter policy');
    assert.ok(
      refresh.flags.has('path=/api/auth'),
      'the refresh token must not be sent on ordinary API calls',
    );

    const csrf = attributesOf(response, 'cma_csrf');
    assert.ok(!csrf.flags.has('httponly'), 'the CSRF token is readable by design');
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    const client = createClient();

    const wrongPassword = await client.login('secretary@church.test', 'not-the-password');
    const unknownEmail = await client.login('nobody@church.test');

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);

    const first = (await wrongPassword.json()).error;
    const second = (await unknownEmail.json()).error;
    assert.equal(first.code, second.code);
    assert.equal(first.message, second.message);
  });

  it('refuses a deactivated account even though the credentials are correct', async () => {
    const client = createClient();
    const response = await client.login('suspended@church.test');

    assert.equal(response.status, 401);
    assert.match((await response.json()).error.message, /deactivated/i);
    assert.equal(response.headers.getSetCookie().length, 0, 'no session may be established');
  });

  it('reports validation problems per field, without echoing the password', async () => {
    const client = createClient();
    const response = await client.call('/api/auth/login', {
      method: 'POST',
      body: { email: 'not-an-email', password: '' },
    });

    assert.equal(response.status, 422);
    const body = await response.text();
    const { error } = JSON.parse(body);

    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.ok(error.details.fields.email);
    assert.ok(error.details.fields.password);
    assert.doesNotMatch(body, /not-an-email/, 'the submitted value must not be echoed back');
  });

  it('rejects unknown fields rather than ignoring them', async () => {
    const client = createClient();
    const response = await client.call('/api/auth/login', {
      method: 'POST',
      body: { email: 'secretary@church.test', password: 'correct-horse-battery', isAdmin: true },
    });

    assert.equal(response.status, 422);
  });

  it('normalises the email, so capitalisation and stray spaces still sign in', async () => {
    const client = createClient();
    const response = await client.call('/api/auth/login', {
      method: 'POST',
      body: { email: '  Secretary@Church.TEST ', password: 'correct-horse-battery' },
    });

    assert.equal(response.status, 200);
  });

  it('blocks a cross-site post outright', async () => {
    const client = createClient();
    const response = await client.call('/api/auth/login', {
      method: 'POST',
      body: { email: 'secretary@church.test', password: 'correct-horse-battery' },
      headers: { 'sec-fetch-site': 'cross-site' },
    });

    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'CSRF_FAILED');
  });

  it('blocks a post whose Origin is not us, when the browser sent no Sec-Fetch-Site', async () => {
    const client = createClient();
    const response = await client.call('/api/auth/login', {
      method: 'POST',
      body: { email: 'secretary@church.test', password: 'correct-horse-battery' },
      headers: { 'sec-fetch-site': null },
      origin: 'https://evil.example',
    });

    assert.equal(response.status, 403);
  });

  it('accepts a post whose Origin is us', async () => {
    const client = createClient();
    const response = await client.call('/api/auth/login', {
      method: 'POST',
      body: { email: 'secretary@church.test', password: 'correct-horse-battery' },
      headers: { 'sec-fetch-site': null },
      origin: 'http://localhost:3000',
    });

    assert.equal(response.status, 200);
  });

  it('rate limits repeated failures, then reports how long to wait', async () => {
    const client = createClient();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await client.login('secretary@church.test', 'wrong');
      assert.equal(response.status, 401, `attempt ${attempt + 1} should still be a plain refusal`);
    }

    const blocked = await client.login('secretary@church.test', 'wrong');
    assert.equal(blocked.status, 429);

    const { error } = await blocked.json();
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.details.retryAfterSeconds, 900);
  });

  it('does not let the rate limit lock out a different account', async () => {
    const client = createClient();

    for (let attempt = 0; attempt < 11; attempt += 1) {
      await client.login('secretary@church.test', 'wrong');
    }

    // Same IP (null in tests), different email: the email dimension is clear,
    // but the IP dimension is shared. With no IP present only the email counts,
    // which is what lets a second user on a shared address still sign in.
    const other = await client.login('usher@church.test');
    assert.equal(other.status, 200);
  });

  it('clears the rate-limit budget after a successful sign-in', async () => {
    const client = createClient();

    for (let attempt = 0; attempt < 9; attempt += 1) {
      await client.login('secretary@church.test', 'wrong');
    }
    assert.equal((await client.login('secretary@church.test')).status, 200);

    // Budget reset, so nine more failures are again not enough to trip it.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const response = await client.login('secretary@church.test', 'wrong');
      assert.equal(response.status, 401);
    }
  });
});

describe('GET /api/auth/session', () => {
  it('refuses when there are no cookies at all', async () => {
    const client = createClient();
    const response = await client.call('/api/auth/session');

    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHENTICATED');
  });

  it('returns the current user without touching the provider', async () => {
    const client = createClient();
    await client.login('secretary@church.test');

    const response = await client.call('/api/auth/session');
    assert.equal(response.status, 200);

    const { data } = await response.json();
    assert.equal(data.user.id, 'user-1');
    assert.equal(client.calls.refresh.length, 0, 'a fresh token must not be refreshed');
    assert.equal(response.headers.getSetCookie().length, 0, 'nor its cookies rotated');
  });

  it('refreshes a token that is close to expiring, and rotates both tokens', async () => {
    const client = createClient();
    await client.login('secretary@church.test');

    // Replace the access cookie with one expiring in 30s — inside the window.
    client.jar.set('cma_at', mintToken({ sub: 'user-1', expiresInSeconds: 30 }));
    const before = client.jar.get('cma_csrf');

    const response = await client.call('/api/auth/session');
    assert.equal(response.status, 200);
    assert.equal(client.calls.refresh.length, 1);

    assert.equal(response.headers.getSetCookie().length, 3, 'all three cookies are reissued');
    assert.notEqual(client.jar.get('cma_csrf'), before, 'the CSRF token rotates with the session');
    assert.match(client.jar.get('cma_rt'), /refresh-user-1-1/, 'the refresh token rotates too');
  });

  it('refreshes an already-expired token rather than logging the user out', async () => {
    const client = createClient();
    await client.login('secretary@church.test');
    client.jar.set('cma_at', mintToken({ sub: 'user-1', expiresInSeconds: -60 }));

    const response = await client.call('/api/auth/session');
    assert.equal(response.status, 200);
    assert.equal(client.calls.refresh.length, 1);
  });

  it('gives up when the refresh token is rejected', async () => {
    const client = createClient({ failRefresh: true });
    await client.login('secretary@church.test');
    client.jar.set('cma_at', mintToken({ sub: 'user-1', expiresInSeconds: -60 }));

    const response = await client.call('/api/auth/session');
    assert.equal(response.status, 401);
  });

  it('refuses a deactivated account on its next request, without needing a new login', async () => {
    const profiles = structuredClone(FIXTURES.profiles);
    const client = createClient({ profiles });

    await client.login('secretary@church.test');
    assert.equal((await client.call('/api/auth/session')).status, 200);

    // An administrator deactivates them between requests.
    profiles['user-1'].isActive = false;

    const response = await client.call('/api/auth/session');
    assert.equal(response.status, 401);
    assert.match((await response.json()).error.message, /deactivated/i);
  });

  it('reflects a revoked permission immediately, because permissions are not cached in the token', async () => {
    const profiles = structuredClone(FIXTURES.profiles);
    const client = createClient({ profiles });
    await client.login('secretary@church.test');

    profiles['user-1'].grants = [{ permissionKey: 'members.view', branchId: 'branch-main' }];

    const { data } = await (await client.call('/api/auth/session')).json();
    assert.deepEqual(data.permissions, ['members.view']);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears every cookie and revokes the token upstream', async () => {
    const client = createClient();
    await client.login('secretary@church.test');
    const accessToken = client.jar.get('cma_at');

    const response = await client.call('/api/auth/logout', { method: 'POST' });
    assert.equal(response.status, 204);

    assert.deepEqual(client.calls.signOut, [accessToken], 'the refresh token must be revoked');

    for (const name of ['cma_at', 'cma_rt', 'cma_csrf']) {
      assert.equal(client.jar.get(name), '', `${name} should have been cleared`);
    }
  });

  it('clears the refresh cookie on its own Path, or the browser would keep it', async () => {
    const client = createClient();
    await client.login('secretary@church.test');

    const response = await client.call('/api/auth/logout', { method: 'POST' });
    const refresh = attributesOf(response, 'cma_rt');

    assert.ok(refresh.flags.has('path=/api/auth'));
    assert.ok(refresh.flags.has('max-age=0'));
  });

  it('succeeds when there is no session to end', async () => {
    const client = createClient();
    const response = await client.call('/api/auth/logout', { method: 'POST' });

    assert.equal(response.status, 204);
    assert.deepEqual(client.calls.signOut, []);
  });

  it('signs the user out locally even when the provider fails', async () => {
    const client = createClient({ failSignOut: true });
    await client.login('secretary@church.test');

    const response = await client.call('/api/auth/logout', { method: 'POST' });

    // A user who clicks "sign out" must end up signed out whatever GoTrue says.
    assert.equal(response.status, 204);
    assert.equal(client.calls.signOut.length, 1, 'the attempt was made');
    for (const name of ['cma_at', 'cma_rt', 'cma_csrf']) {
      assert.equal(client.jar.get(name), '');
    }
  });

  it('requires the CSRF token, since a session exists by then', async () => {
    const client = createClient();
    await client.login('secretary@church.test');

    const response = await client.call('/api/auth/logout', { method: 'POST', csrf: false });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'CSRF_FAILED');
  });
});

describe('permission-guarded routes', () => {
  it('refuse an anonymous caller', async () => {
    const client = createClient();
    const response = await client.call('/api/health/deep');

    assert.equal(response.status, 401);
  });

  it('admit a caller holding the permission', async () => {
    const client = createClient();
    await client.login('secretary@church.test'); // holds settings.view globally

    const response = await client.call('/api/health/deep');
    assert.equal(response.status, 200);

    const { data } = await response.json();
    assert.equal(data.supabase.configured, false);
    assert.equal(data.supabase.reachable, false);
  });

  it('refuse a caller who is signed in but lacks the permission', async () => {
    const client = createClient();
    await client.login('usher@church.test'); // directory only

    const response = await client.call('/api/health/deep');
    assert.equal(response.status, 403);

    const { error } = await response.json();
    assert.equal(error.code, 'FORBIDDEN');
    assert.doesNotMatch(
      error.message,
      /settings\.view/,
      'the message must not name the permission',
    );
  });

  it('refuse an expired token, which the client turns into a refresh and retry', async () => {
    const client = createClient();
    await client.login('secretary@church.test');
    client.jar.set('cma_at', mintToken({ sub: 'user-1', expiresInSeconds: -10 }));

    const response = await client.call('/api/health/deep');
    assert.equal(response.status, 401);
    assert.equal(client.calls.refresh.length, 0, 'ordinary routes must never refresh');
  });
});

describe('POST /api/auth/password/forgot', () => {
  it('answers identically for a known and an unknown address', async () => {
    const client = createClient();

    const known = await client.call('/api/auth/password/forgot', {
      method: 'POST',
      body: { email: 'secretary@church.test' },
    });
    const unknown = await client.call('/api/auth/password/forgot', {
      method: 'POST',
      body: { email: 'nobody@church.test' },
    });

    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.deepEqual(await known.json(), await unknown.json());
  });

  it('asks the provider to send the link back to our own reset page', async () => {
    const client = createClient();
    await client.call('/api/auth/password/forgot', {
      method: 'POST',
      body: { email: 'secretary@church.test' },
    });

    assert.deepEqual(client.calls.resetRequested, [
      { email: 'secretary@church.test', redirectTo: 'http://localhost:3000/reset-password' },
    ]);
  });

  it('rate limits requests for the same address', async () => {
    const client = createClient();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await client.call('/api/auth/password/forgot', {
        method: 'POST',
        body: { email: 'secretary@church.test' },
      });
      assert.equal(response.status, 202);
    }

    const blocked = await client.call('/api/auth/password/forgot', {
      method: 'POST',
      body: { email: 'secretary@church.test' },
    });
    assert.equal(blocked.status, 429);
  });
});

describe('POST /api/auth/password/reset', () => {
  const valid = {
    tokenHash: 'valid-recovery-token-hash',
    password: 'a-much-longer-passphrase',
  };

  it('changes the password and leaves the user signed out', async () => {
    const client = createClient();
    const response = await client.call('/api/auth/password/reset', { method: 'POST', body: valid });

    assert.equal(response.status, 204);
    assert.equal(client.calls.passwordUpdated.length, 1);

    // Cleared rather than set: after a recovery the user signs in again, and any
    // session an attacker held is ended.
    for (const name of ['cma_at', 'cma_rt', 'cma_csrf']) {
      assert.equal(client.jar.get(name), '');
    }
  });

  it('refuses an expired or reused link', async () => {
    const client = createClient();
    const response = await client.call('/api/auth/password/reset', {
      method: 'POST',
      body: { ...valid, tokenHash: 'stale-token-hash' },
    });

    assert.equal(response.status, 401);
    assert.match((await response.json()).error.message, /expired or has already been used/);
  });

  it('refuses a password that is too short, and says how long it must be', async () => {
    const client = createClient();
    const response = await client.call('/api/auth/password/reset', {
      method: 'POST',
      body: { ...valid, password: 'short' },
    });

    assert.equal(response.status, 422);
    const { error } = await response.json();
    assert.match(error.details.fields.password, /12 characters/);
    assert.equal(client.calls.passwordUpdated.length, 0);
  });

  it('never echoes the submitted password', async () => {
    const client = createClient();
    const response = await client.call('/api/auth/password/reset', {
      method: 'POST',
      body: { ...valid, password: 'short-and-memorable' },
    });

    assert.doesNotMatch(await response.text(), /short-and-memorable/);
  });
});
