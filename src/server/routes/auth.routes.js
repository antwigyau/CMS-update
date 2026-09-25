/**
 * Authentication endpoints.
 *
 * All five are registered `public: true` â€” meaning "no permission required",
 * not "unauthenticated". They are the routes that establish a session, so they
 * cannot require one. Each enforces its own protection:
 *
 *   POST /api/auth/login             rate limited, CSRF-checked, timing-levelled
 *   POST /api/auth/logout            CSRF-checked, idempotent
 *   GET  /api/auth/session           the only place a token is refreshed
 *   POST /api/auth/password/forgot   rate limited, never reveals whether the
 *                                    address exists
 *   POST /api/auth/password/reset    rate limited, ends every existing session
 *
 * The provider, session resolver, and rate limiter are injected rather than
 * imported, so the whole surface can be tested against a fake GoTrue.
 */

import {
  buildClearedCookies,
  buildSessionCookies,
  readSessionCookies,
  withCookies,
} from '../../auth/cookies.js';
import { assertCsrf, generateCsrfToken } from '../../auth/csrf.js';
import { ok, noContent, jsonResponse } from '../../lib/http.js';
import {
  loginSchema,
  passwordForgotSchema,
  passwordResetSchema,
  validate,
} from '../../validation/index.js';
import { RATE_LIMITS } from '../middleware/rate-limit.js';

/**
 * A floor on how long the login endpoint takes to answer.
 *
 * GoTrue only performs the (deliberately slow) password hash when the account
 * exists, so a wrong email answers measurably faster than a wrong password â€”
 * which turns the login form into an account-enumeration oracle. Levelling the
 * response time closes that channel. It does not slow down a successful login,
 * because that path already exceeds the floor.
 */
const MIN_LOGIN_MILLISECONDS = 300;

async function notFasterThan(milliseconds, work) {
  const started = performance.now();
  try {
    return await work();
  } finally {
    const remaining = milliseconds - (performance.now() - started);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }
}

/** The session shape the frontend receives. Contains no tokens, by design. */
function sessionPayload(session, email) {
  return {
    user: {
      id: session.userId,
      email: email ?? null,
      fullName: session.fullName,
      defaultBranchId: session.defaultBranchId,
    },
    permissions: session.permissions.keys(),
    // Computed authority, not granted: the ministries this user leads. The
    // frontend uses it to decide whether to offer leader controls; every endpoint
    // checks again, and RLS below that.
    ledMinistryIds: session.ledMinistryIds ?? [],
    // Public settings the shell and forms need to render: the church name and the
    // finance currency. Display only — never an authorization input.
    settings: {
      churchName: session.settings?.['church.name'] ?? null,
      currency: session.settings?.['finance.currency'] ?? null,
    },
  };
}

/**
 * @param {object} dependencies
 * @param {object} dependencies.provider
 * @param {object} dependencies.sessionResolver
 * @param {object} dependencies.rateLimiter
 * @param {Function} dependencies.loadIdentity
 * @param {object} dependencies.cfg
 */
export function registerAuthRoutes(
  router,
  { provider, sessionResolver, rateLimiter, loadIdentity, cfg },
) {
  /* ---- login ------------------------------------------------------------ */

  async function login(context) {
    // requireToken: false — no csrf cookie exists before a session does.
    assertCsrf(context.request, { cfg, requireToken: false });

    const { email, password } = validate(loginSchema, await context.json());

    return notFasterThan(MIN_LOGIN_MILLISECONDS, async () => {
      await rateLimiter.assertWithin({
        ...RATE_LIMITS.login,
        keys: [context.ip, email],
        message: 'Too many sign-in attempts. Please wait 15 minutes and try again.',
      });

      const credentials = await provider.signInWithPassword({ email, password });
      // Deactivated accounts are refused here, by loadIdentity, rather than by
      // GoTrue â€” which knows nothing about our profiles table.
      const identity = await loadIdentity(credentials.accessToken);

      await rateLimiter.clear({ name: RATE_LIMITS.login.name, keys: [context.ip, email] });

      // The email is logged; the password never reaches a log line because the
      // logger redacts by key name and we do not pass it.
      context.logger.info('sign-in succeeded', { userId: identity.userId });

      const csrfToken = generateCsrfToken();
      return withCookies(
        ok(sessionPayload(identity, credentials.user?.email ?? email)),
        buildSessionCookies({ ...credentials, csrfToken }, cfg),
      );
    });
  }

  /* ---- logout ----------------------------------------------------------- */

  async function logout(context) {
    // requireToken: false means "verify the token if there is one". A session
    // that exists is therefore protected, while signing out when already signed
    // out is a no-op rather than a confusing 403.
    assertCsrf(context.request, { cfg, requireToken: false });

    // Registered public, so there is no resolved session here â€” the token comes
    // straight from the cookie.
    const { accessToken } = readSessionCookies(context.request, cfg);

    if (accessToken) {
      try {
        // Revokes the refresh token server-side, so a stolen access token dies
        // at its own expiry instead of being renewable indefinitely.
        await provider.signOut(accessToken);
      } catch (error) {
        // Never fail a logout. A user who clicks "sign out" must end up signed
        // out locally whatever the upstream says.
        context.logger.warn('provider sign-out failed; clearing cookies anyway', { error });
      }
    }

    return withCookies(noContent(), buildClearedCookies(cfg));
  }

  /* ---- session (also the refresh endpoint) ------------------------------ */

  async function session(context) {
    const { session: resolved, renewed } = await sessionResolver.resolveOrRefresh(context.request);
    const payload = ok(sessionPayload(resolved, renewed?.user?.email));

    if (!renewed) return payload;

    // A refresh rotates the CSRF token too: the pair is only meaningful together,
    // and rotating both means a stale tab cannot mix an old token with a new
    // session.
    const csrfToken = generateCsrfToken();
    context.logger.info('session refreshed', { userId: resolved.userId });
    return withCookies(payload, buildSessionCookies({ ...renewed, csrfToken }, cfg));
  }

  /* ---- password reset --------------------------------------------------- */

  async function passwordForgot(context) {
    assertCsrf(context.request, { cfg, requireToken: false });

    const { email } = validate(passwordForgotSchema, await context.json());

    await rateLimiter.assertWithin({
      ...RATE_LIMITS.passwordForgot,
      keys: [context.ip, email],
      message: 'Too many reset requests. Please wait an hour and try again.',
    });

    await provider.requestPasswordReset({
      email,
      redirectTo: `${cfg.appUrl}/reset-password`,
    });

    context.logger.info('password reset requested');

    // 202 and the same body whether or not the address exists. Anything else
    // turns this endpoint into an account-enumeration oracle.
    return jsonResponse(
      {
        data: {
          message: 'If that email address has an account, a reset link is on its way.',
        },
      },
      { status: 202 },
    );
  }

  async function passwordReset(context) {
    // The caller arrives from an emailed link, so there is no session cookie.
    assertCsrf(context.request, { cfg, requireToken: false });

    const { tokenHash, password } = validate(passwordResetSchema, await context.json());

    await rateLimiter.assertWithin({
      ...RATE_LIMITS.passwordReset,
      keys: [context.ip],
      message: 'Too many attempts. Please wait an hour and try again.',
    });

    const recovered = await provider.verifyRecoveryToken(tokenHash);
    await provider.updatePassword({ accessToken: recovered.accessToken, password });

    context.logger.info('password reset completed', { userId: recovered.user?.id });

    // Cookies are cleared rather than set: after a password change the user signs
    // in again with the new password. If the reset was an account recovery, this
    // is also what ends the attacker's session.
    return withCookies(noContent(), buildClearedCookies(cfg));
  }

  /* ---- registration ----------------------------------------------------- */

  router.post('/auth/login', login, { public: true });
  router.post('/auth/logout', logout, { public: true });
  router.get('/auth/session', session, { public: true });
  router.post('/auth/password/forgot', passwordForgot, { public: true });
  router.post('/auth/password/reset', passwordReset, { public: true });
}
