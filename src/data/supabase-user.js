/**
 * Supabase clients for request-scoped, user-authorised access.
 *
 * `createUserClient(accessToken)` is the DEFAULT way this application reads and
 * writes data. It uses the anon key plus the caller's JWT, so every query is
 * subject to Row Level Security exactly as if the user had connected directly.
 * If an RLS policy is wrong, this client is blocked — which is the point.
 *
 * See src/data/supabase-admin.js for the narrow, allow-listed exception.
 */

import { createClient } from '@supabase/supabase-js';
import { requireSupabaseConfig } from '../config/env.js';
import { APP_NAME, APP_VERSION } from '../lib/version.js';

/**
 * Serverless-safe client options.
 *
 * Session persistence and auto-refresh are OFF: there is no browser here, and a
 * function instance is shared across users. Holding auth state on the client
 * object would leak one user's session into another user's request.
 */
const BASE_OPTIONS = Object.freeze({
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: {
    headers: { 'x-client-info': `${APP_NAME}/${APP_VERSION}` },
  },
});

/**
 * Anon client with no user attached. Used only for Supabase Auth calls that
 * establish identity (sign-in, password reset) — never for table access.
 */
export function createAnonClient() {
  const { url, anonKey } = requireSupabaseConfig();
  return createClient(url, anonKey, BASE_OPTIONS);
}

/**
 * Client acting as the signed-in user. RLS applies.
 * @param {string} accessToken  The Supabase access token from the session cookie.
 */
export function createUserClient(accessToken) {
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new TypeError('createUserClient requires the caller access token');
  }

  const { url, anonKey } = requireSupabaseConfig();
  return createClient(url, anonKey, {
    ...BASE_OPTIONS,
    global: {
      headers: {
        ...BASE_OPTIONS.global.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}
