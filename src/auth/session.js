/**
 * Turning cookies into a session.
 *
 * The refresh policy is the interesting part. A naive "refresh whenever the
 * token is close to expiring" races badly in a serverless environment: several
 * concurrent requests from one browser each see the same nearly-expired token,
 * each calls refresh, and GoTrue's refresh-token rotation invalidates all but
 * one — logging the user out mid-session.
 *
 * So refreshing happens in exactly one place: `GET /api/auth/session`, which the
 * client calls on a timer and once after any 401 before retrying. Ordinary API
 * requests never refresh. They accept a valid token, and return 401 for an
 * expired one, which the client turns into a refresh-then-retry.
 *
 * The consequence to be aware of: a request arriving in the window between token
 * expiry and the client's next session call gets one 401. That is a retry, not a
 * logout, and it is a better failure than a rotation race.
 */

import { unauthenticated } from '../lib/errors.js';
import { readSessionCookies } from './cookies.js';

/** Refresh when the access token has this long or less to live. */
export const REFRESH_WINDOW_SECONDS = 120;

/**
 * Read the `exp` claim without verifying the signature.
 *
 * This is used ONLY to decide when to refresh. It is never an authorization
 * input: every database query carries the token to Supabase, which verifies it
 * properly. A forged `exp` therefore buys an attacker nothing but a pointless
 * refresh attempt, which will itself fail.
 */
export function readTokenExpiry(accessToken) {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return null;

    const json = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    // A token we cannot read is a token we cannot schedule around. Treated as
    // "no expiry known", which means "do not pre-emptively refresh".
    return null;
  }
}

export function isExpired(accessToken, now = Date.now()) {
  const exp = readTokenExpiry(accessToken);
  if (exp === null) return false;
  return exp * 1000 <= now;
}

export function isNearExpiry(accessToken, now = Date.now()) {
  const exp = readTokenExpiry(accessToken);
  if (exp === null) return false;
  return exp * 1000 - now <= REFRESH_WINDOW_SECONDS * 1000;
}

/**
 * @param {object} dependencies
 * @param {object} dependencies.provider      The auth provider (see auth/provider.js).
 * @param {Function} dependencies.loadIdentity
 * @param {object} [dependencies.cfg]
 */
export function createSessionResolver({ provider, loadIdentity, cfg }) {
  /**
   * Resolve the session for an ordinary API request. Never refreshes.
   *
   * @returns {Promise<object>} the session context
   * @throws {AppError} 401 when there is no usable session
   */
  async function requireSession(request) {
    const { accessToken, csrfToken } = readSessionCookies(request, cfg);

    if (!accessToken) {
      throw unauthenticated('You are not signed in.');
    }
    if (isExpired(accessToken)) {
      // The client's cue to call /api/auth/session and retry once.
      throw unauthenticated('Your session has expired.');
    }

    const identity = await loadIdentity(accessToken);
    return { ...identity, accessToken, csrfToken, refreshed: false };
  }

  /**
   * Resolve the session for `GET /api/auth/session`, refreshing if the token is
   * within the refresh window or already expired.
   *
   * @returns {Promise<{session: object, renewed: object|null}>}
   *   `renewed` carries new tokens when a refresh happened, so the caller can
   *   set cookies. It is null otherwise.
   */
  async function resolveOrRefresh(request) {
    const { accessToken, refreshToken, csrfToken } = readSessionCookies(request, cfg);

    if (!accessToken && !refreshToken) {
      throw unauthenticated('You are not signed in.');
    }

    const needsRefresh = !accessToken || isExpired(accessToken) || isNearExpiry(accessToken);

    if (needsRefresh) {
      if (!refreshToken) {
        throw unauthenticated('Your session has expired. Please sign in again.');
      }

      const renewed = await provider.refreshSession(refreshToken);
      const identity = await loadIdentity(renewed.accessToken);
      return {
        session: { ...identity, accessToken: renewed.accessToken, csrfToken, refreshed: true },
        renewed,
      };
    }

    const identity = await loadIdentity(accessToken);
    return {
      session: { ...identity, accessToken, csrfToken, refreshed: false },
      renewed: null,
    };
  }

  return { requireSession, resolveOrRefresh };
}
