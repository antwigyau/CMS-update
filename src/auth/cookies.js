/**
 * Session cookies.
 *
 * Three cookies, per ADR-003:
 *
 *   cma_at    access token   HttpOnly, SameSite=Lax,    Path=/
 *   cma_rt    refresh token  HttpOnly, SameSite=Strict, Path=/api/auth
 *   cma_csrf  CSRF token     readable by JS BY DESIGN,  Path=/
 *
 * Why `cma_rt` is scoped to /api/auth: the refresh token is the long-lived
 * credential. Scoping it to the only endpoints that can use it means it is not
 * transmitted on ordinary API calls at all, so a logging mistake or a proxy that
 * records headers sees the short-lived access token instead.
 *
 * Why `cma_csrf` is readable: it is not a credential. It is worthless without the
 * other two, and the frontend must be able to echo it into a header — that echo
 * is the whole double-submit mechanism.
 */

import { config } from '../config/env.js';

/** Cookie name suffixes; the prefix comes from SESSION_COOKIE_PREFIX. */
const NAMES = Object.freeze({ access: 'at', refresh: 'rt', csrf: 'csrf' });

export const REFRESH_COOKIE_PATH = '/api/auth';

export function cookieName(kind, cfg = config) {
  const suffix = NAMES[kind];
  if (!suffix) throw new Error(`Unknown cookie kind: ${kind}`);
  return `${cfg.cookiePrefix}_${suffix}`;
}

/**
 * Secure is derived from APP_URL rather than hardcoded: a Secure cookie is
 * dropped over plain http, which would make local development silently fail to
 * log in. Deployed environments are always https.
 */
function isSecure(cfg) {
  return cfg.appUrl.startsWith('https://') || cfg.isDeployed;
}

function serialise(name, value, { maxAge, path = '/', sameSite = 'Lax', httpOnly = true }, cfg) {
  const parts = [`${name}=${value}`, `Path=${path}`, `SameSite=${sameSite}`];

  if (httpOnly) parts.push('HttpOnly');
  if (isSecure(cfg)) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);

  return parts.join('; ');
}

/**
 * Parse a Cookie header.
 *
 * Deliberately tolerant of odd input — a malformed header from a proxy should
 * mean "no session", not a 500. Values are not decoded: all three of our cookies
 * are tokens from a restricted alphabet, and decoding would let `%3B` smuggle a
 * separator through.
 */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;

  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const name = pair.slice(0, index).trim();
    if (name === '') continue;
    out[name] = pair.slice(index + 1).trim();
  }
  return out;
}

export function readSessionCookies(request, cfg = config) {
  const cookies = parseCookies(request.headers.get('cookie'));
  return {
    accessToken: cookies[cookieName('access', cfg)] ?? null,
    refreshToken: cookies[cookieName('refresh', cfg)] ?? null,
    csrfToken: cookies[cookieName('csrf', cfg)] ?? null,
  };
}

/**
 * Build the Set-Cookie headers that establish a session.
 *
 * @param {object} session
 * @param {string} session.accessToken
 * @param {string} session.refreshToken
 * @param {number} [session.expiresIn]  Seconds until the access token expires.
 * @param {string} session.csrfToken
 */
export function buildSessionCookies(
  { accessToken, refreshToken, expiresIn, csrfToken },
  cfg = config,
) {
  // The access cookie outlives the token slightly: the session endpoint needs to
  // receive an expired token in order to refresh it. If the cookie vanished at
  // the same moment, the user would be logged out instead of refreshed.
  const accessMaxAge = Math.max(60, (expiresIn ?? 3600) + 300);

  return [
    serialise(cookieName('access', cfg), accessToken, { maxAge: accessMaxAge }, cfg),
    serialise(
      cookieName('refresh', cfg),
      refreshToken,
      { maxAge: 60 * 60 * 24 * 30, path: REFRESH_COOKIE_PATH, sameSite: 'Strict' },
      cfg,
    ),
    serialise(cookieName('csrf', cfg), csrfToken, { maxAge: accessMaxAge, httpOnly: false }, cfg),
  ];
}

/**
 * Build the Set-Cookie headers that clear a session.
 *
 * Every cookie must be cleared with the same Path it was set with, or the
 * browser keeps the original — which is how "logged out" sessions come back.
 */
export function buildClearedCookies(cfg = config) {
  return [
    serialise(cookieName('access', cfg), '', { maxAge: 0 }, cfg),
    serialise(
      cookieName('refresh', cfg),
      '',
      { maxAge: 0, path: REFRESH_COOKIE_PATH, sameSite: 'Strict' },
      cfg,
    ),
    serialise(cookieName('csrf', cfg), '', { maxAge: 0, httpOnly: false }, cfg),
  ];
}

/** Attach Set-Cookie headers to a Response, preserving its body and status. */
export function withCookies(response, cookies) {
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
