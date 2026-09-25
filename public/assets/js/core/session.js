/**
 * Client-side session handling.
 *
 * The browser never holds a token — the session lives in HttpOnly cookies it
 * cannot read. What it holds is the *answer* to "who am I and what may I do",
 * fetched from `GET /api/auth/session`.
 *
 * Two responsibilities:
 *
 *   1. Gate a page. `requireSession()` fetches the session and sends the visitor
 *      to the sign-in page if there is none. This is UX, not security: the API
 *      and RLS refuse the request regardless of what the page renders.
 *
 *   2. Keep the session alive. A timer re-fetches before the access token
 *      expires, which is also the only place a refresh happens — see the note in
 *      src/auth/session.js about why refreshing anywhere else races.
 */

import { ApiError, api } from './api.js';

/** Well short of the access token's ~1 hour, and short of the 2-minute window. */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

const SIGN_IN_PATH = '/';

let current = null;
let timer = null;

/** The signed-in user and their permissions, or null before requireSession(). */
export function getSession() {
  return current;
}

export function can(permission) {
  return current?.permissions?.includes(permission) ?? false;
}

/** The configured display currency (ISO 4217), or null before it is known. */
export function currency() {
  return current?.settings?.currency ?? null;
}

/** The church name for the shell, falling back to a neutral default. */
export function churchName() {
  return current?.settings?.churchName ?? 'Church Manager';
}

/**
 * Does this user lead the given ministry?
 *
 * Leadership is computed authority, not a permission — a leader may edit their own
 * ministry without holding `ministries.update` anywhere. This is used to decide
 * whether to render leader controls; the endpoint checks again, and RLS below that.
 */
export function leadsMinistry(ministryId) {
  return (current?.ledMinistryIds ?? []).includes(ministryId);
}

/** True if the user leads any ministry at all — for showing a whole section. */
export function leadsAnyMinistry() {
  return (current?.ledMinistryIds ?? []).length > 0;
}

/** Where to send someone after signing in — back to what they asked for. */
function signInUrl() {
  const wanted = `${location.pathname}${location.search}`;
  if (wanted === SIGN_IN_PATH || wanted === '/index.html') return SIGN_IN_PATH;
  return `${SIGN_IN_PATH}?next=${encodeURIComponent(wanted)}`;
}

export function redirectToSignIn() {
  location.assign(signInUrl());
}

/**
 * Fetch the session, refreshing the token if the server decides it is due.
 * @returns {Promise<object|null>}
 */
export async function loadSession() {
  try {
    const payload = await api.get('/auth/session');
    current = payload.data;
    return current;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      current = null;
      return null;
    }
    throw error;
  }
}

/**
 * Gate a protected page. Resolves with the session, or navigates away and
 * resolves with null — callers should stop rendering when it returns null.
 */
export async function requireSession() {
  const session = await loadSession();
  if (!session) {
    redirectToSignIn();
    return null;
  }
  startKeepAlive();
  return session;
}

function startKeepAlive() {
  if (timer !== null) return;

  timer = setInterval(() => {
    loadSession().then((session) => {
      if (!session) {
        stopKeepAlive();
        redirectToSignIn();
      }
    });
  }, REFRESH_INTERVAL_MS);

  // A 401 from any other request means the token expired between polls. One
  // session call refreshes it; if that fails, the session is genuinely over.
  document.addEventListener('cma:unauthenticated', async () => {
    if (!(await loadSession())) {
      stopKeepAlive();
      redirectToSignIn();
    }
  });
}

export function stopKeepAlive() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export async function signOut() {
  try {
    await api.post('/auth/logout');
  } catch {
    // A failed sign-out request must still sign the user out of this tab: the
    // cookies may already be gone, and staying put would be worse.
  } finally {
    current = null;
    stopKeepAlive();
    location.assign(SIGN_IN_PATH);
  }
}
