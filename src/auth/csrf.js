/**
 * CSRF protection for state-changing requests.
 *
 * Two independent checks, because each covers a case the other misses:
 *
 * 1. **Origin / Sec-Fetch-Site.** Cheap, and catches the ordinary cross-site
 *    form post. But `Origin` is absent on some same-origin requests and can be
 *    absent entirely from non-browser clients, so it cannot be the only check.
 *
 * 2. **Double-submit token.** The `cma_csrf` cookie must match the
 *    `X-CSRF-Token` header. An attacker on another origin can cause the cookie
 *    to be *sent* but cannot *read* it, so they cannot produce the header. This
 *    works even when `Origin` is missing.
 *
 * `SameSite` on the session cookies is a third layer, but it is a browser
 * default we do not control and has known gaps, so it is not relied on alone.
 *
 * Comparison is constant-time. A timing oracle on a CSRF token is a stretch, but
 * the cost of doing it properly is four lines.
 */

import { config } from '../config/env.js';
import { csrfFailed } from '../lib/errors.js';
import { cookieName, parseCookies } from './cookies.js';

const CSRF_HEADER = 'x-csrf-token';
const TOKEN_BYTES = 32;

/** Methods that cannot change state, and so need no CSRF check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function generateCsrfToken() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  // Hex rather than base64: no '+', '/', or '=' to be re-encoded on the way
  // through a cookie, a header, or a URL.
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison. Returns false for any length mismatch. */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

/**
 * Is this request same-origin, as far as the browser will tell us?
 *
 * `null` means "the browser did not say" — not "no". The caller treats that as
 * inconclusive and falls through to the token check rather than refusing, which
 * keeps non-browser clients (curl, tests, server-to-server) working while still
 * requiring the token.
 */
export function checkOrigin(request, cfg = config) {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite) {
    // 'none' is a user-initiated navigation, e.g. typing the URL. A
    // state-changing request cannot legitimately arrive that way.
    return fetchSite === 'same-origin';
  }

  const origin = request.headers.get('origin');
  if (origin) return origin === cfg.appUrl;

  return null;
}

/**
 * Enforce CSRF protection. Throws on failure; returns silently on success.
 *
 * @param {Request} request
 * @param {object} [options]
 * @param {object} [options.cfg]
 * @param {boolean} [options.requireToken=true]
 *   `false` for the endpoints that run BEFORE a session exists — sign-in and
 *   password reset. There is no `cma_csrf` cookie to double-submit yet, so
 *   demanding one would make signing in impossible. Those routes therefore rest
 *   on the Origin / Sec-Fetch-Site check, and on the token too if a cookie from a
 *   previous session happens to still be present.
 *
 *   This is a deliberate, bounded weakening. What it exposes is "login CSRF":
 *   an attacker can cause a victim's browser to sign in as the attacker. That is
 *   a nuisance rather than a breach — it grants the attacker nothing and reveals
 *   nothing — and the Origin check blocks it from any origin a browser labels.
 */
export function assertCsrf(request, { cfg = config, requireToken = true } = {}) {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;

  const sameOrigin = checkOrigin(request, cfg);
  if (sameOrigin === false) {
    throw csrfFailed('This request appears to come from another site and was blocked.');
  }

  const cookies = parseCookies(request.headers.get('cookie'));
  const fromCookie = cookies[cookieName('csrf', cfg)];
  const fromHeader = request.headers.get(CSRF_HEADER);

  if (!requireToken && !fromCookie) {
    // Pre-session request with no token to check. The Origin check above is what
    // stands between this and a cross-site post; `null` there means the browser
    // did not label the request, which no browser-driven cross-site POST omits.
    return;
  }

  if (!fromCookie || !fromHeader) {
    throw csrfFailed('This request is missing its security token. Reload the page and try again.');
  }
  if (!timingSafeEqual(fromCookie, fromHeader)) {
    throw csrfFailed('This request failed a security check. Reload the page and try again.');
  }
}
