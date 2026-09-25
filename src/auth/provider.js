/**
 * The Supabase Auth (GoTrue) boundary.
 *
 * Every call into GoTrue happens here and nowhere else. Two reasons:
 *
 * 1. Failures are translated once. GoTrue distinguishes "no such user" from
 *    "wrong password"; we deliberately collapse both into one message so the
 *    login form cannot be used to discover which addresses have accounts.
 *
 * 2. It is injectable. `createAuthRoutes({ provider })` takes this shape, so the
 *    session, cookie, CSRF, and rate-limit logic can be tested exhaustively
 *    against a fake — and the real implementation stays thin enough that little
 *    is left untested by that substitution.
 */

import { createAnonClient, createUserClient } from '../data/supabase-user.js';
import { internalError, unauthenticated } from '../lib/errors.js';

/** GoTrue's own wording varies; the client never learns which case it hit. */
const CREDENTIALS_MESSAGE = 'That email address and password combination is not recognised.';

function toSession(data) {
  const session = data?.session;
  if (!session?.access_token || !session?.refresh_token) {
    throw internalError('Supabase returned no session for a successful sign-in.');
  }

  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresIn: session.expires_in ?? 3600,
    expiresAt: session.expires_at ?? null,
    user: { id: data.user?.id ?? session.user?.id, email: data.user?.email ?? session.user?.email },
  };
}

export function createSupabaseAuthProvider() {
  return {
    async signInWithPassword({ email, password }) {
      const client = createAnonClient();
      const { data, error } = await client.auth.signInWithPassword({ email, password });

      if (error) {
        // The original reason goes to the log via `cause`, never to the client.
        throw unauthenticated(CREDENTIALS_MESSAGE, { cause: error });
      }
      return toSession(data);
    },

    async refreshSession(refreshToken) {
      const client = createAnonClient();
      const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });

      if (error) {
        throw unauthenticated('Your session has expired. Please sign in again.', { cause: error });
      }
      return toSession(data);
    },

    async signOut(accessToken) {
      // Scoped to this session's token, so signing out on a phone does not end
      // the same user's desktop session.
      const client = createUserClient(accessToken);
      await client.auth.signOut();
    },

    async requestPasswordReset({ email, redirectTo }) {
      const client = createAnonClient();
      // The result is deliberately ignored: the caller always reports success, so
      // an unknown address is indistinguishable from a known one.
      await client.auth.resetPasswordForEmail(email, { redirectTo });
    },

    /**
     * Exchange the `token_hash` from a recovery email for a session.
     *
     * This is the server-side half of the reset flow: the emailed link points at
     * our own page carrying `token_hash` and `type=recovery`, and this call turns
     * that into a session with which the password can be changed. It requires the
     * "Reset Password" email template in the Supabase dashboard to link to
     * `{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&type=recovery`
     * rather than to the default `{{ .ConfirmationURL }}`.
     *
     * That template change is a deployment step, recorded in docs/DEPLOYMENT.md.
     * Until it is made, the emailed link will not reach this code path.
     */
    async verifyRecoveryToken(tokenHash) {
      const client = createAnonClient();
      const { data, error } = await client.auth.verifyOtp({
        token_hash: tokenHash,
        type: 'recovery',
      });

      if (error || !data?.session) {
        throw unauthenticated('That password reset link has expired or has already been used.', {
          cause: error,
        });
      }
      return toSession(data);
    },

    async updatePassword({ accessToken, password }) {
      const client = createUserClient(accessToken);
      const { error } = await client.auth.updateUser({ password });
      if (error) {
        throw unauthenticated('That password reset link is no longer valid. Request a new one.', {
          cause: error,
        });
      }
    },

    async getUser(accessToken) {
      const client = createUserClient(accessToken);
      const { data, error } = await client.auth.getUser();
      if (error || !data?.user) return null;
      return { id: data.user.id, email: data.user.email };
    },
  };
}
