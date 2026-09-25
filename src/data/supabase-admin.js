/**
 * PRIVILEGED. Service-role Supabase client — Row Level Security does NOT apply.
 *
 * A bug in a module using this client is a full data breach, not a 403. Rules:
 *
 *   1. Importing this module is blocked by ESLint everywhere except the
 *      allow-list in eslint.config.js. Adding a file to that list is a
 *      deliberate, reviewable act.
 *   2. Legitimate uses are only those a user genuinely cannot perform as
 *      themselves: creating auth users, writing immutable audit rows, and
 *      cross-branch aggregate reporting.
 *   3. Never pass user input through to a query on this client without having
 *      already authorised the operation at the API layer — there is no second
 *      line of defence here.
 */

import { createClient } from '@supabase/supabase-js';
import { requireSupabaseAdminConfig } from '../config/env.js';
import { APP_NAME, APP_VERSION } from '../lib/version.js';

let cached = null;

export function createAdminClient() {
  if (cached) return cached;

  const { url, serviceRoleKey } = requireSupabaseAdminConfig();
  cached = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-client-info': `${APP_NAME}/${APP_VERSION}-admin` } },
  });
  return cached;
}

/** Test seam — drops the cached client so config changes take effect. */
export function resetAdminClient() {
  cached = null;
}
