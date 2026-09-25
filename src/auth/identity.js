/**
 * Who the caller is, according to the database.
 *
 * Permissions are read live from `app.my_permissions()` on each request rather
 * than cached in the JWT. That is a deliberate trade:
 *
 *   * a revoked role takes effect on the very next request, not when the token
 *     next happens to be reissued
 *   * it costs one extra round trip per authenticated request
 *
 * For a back-office application with tens of concurrent users, correctness is
 * worth more than the round trip. Supabase's Custom Access Token Hook could move
 * this into the token later, at the documented cost that **role** changes then
 * lag until the next token is issued while permission changes stay immediate.
 * That trade is recorded in the blueprint and is not made here.
 */

import { createUserClient } from '../data/supabase-user.js';
import { unauthenticated } from '../lib/errors.js';

/**
 * A permission set with branch scoping resolved.
 *
 * `branchId === null` in a grant means "every branch", so a null-scoped grant
 * satisfies a check for any branch. A branch-scoped grant satisfies only that
 * branch, and satisfies an unscoped check — "may they do this anywhere?".
 */
export function createPermissionSet(grants) {
  const global = new Set();
  const scoped = new Map(); // permission key -> Set<branchId>

  for (const { permissionKey, branchId } of grants) {
    if (branchId === null || branchId === undefined) {
      global.add(permissionKey);
    } else {
      if (!scoped.has(permissionKey)) scoped.set(permissionKey, new Set());
      scoped.get(permissionKey).add(branchId);
    }
  }

  return {
    /**
     * @param {string} permission
     * @param {string} [branchId]  Omit to ask "anywhere at all?".
     */
    can(permission, branchId) {
      if (global.has(permission)) return true;
      const branches = scoped.get(permission);
      if (!branches) return false;
      return branchId === undefined ? branches.size > 0 : branches.has(branchId);
    },

    /** Every permission key held, in any scope. For the /session response. */
    keys() {
      return [...new Set([...global, ...scoped.keys()])].sort();
    },

    /** Branches in which this permission is held; null means every branch. */
    branchesFor(permission) {
      if (global.has(permission)) return null;
      return [...(scoped.get(permission) ?? [])];
    },
  };
}

/**
 * Load the caller's identity as the caller.
 *
 * Uses the user-scoped client, so RLS applies: the profile row comes back
 * because `profiles_select_own` allows it, not because we bypassed anything.
 */
export function createIdentityLoader() {
  return async function loadIdentity(accessToken) {
    const client = createUserClient(accessToken);

    const [profileResult, permissionResult, ledResult, settingsResult] = await Promise.all([
      client.from('profiles').select('id, full_name, is_active, default_branch_id').maybeSingle(),
      client.rpc('my_permissions'),
      // Ministry leadership is computed from ministry_members, not granted. It is
      // loaded here so the API guards can honour it without a round trip per
      // check — see ADR-042 for why it belongs in the session rather than being
      // queried per request.
      client.rpc('my_led_ministry_ids'),
      // Public settings the frontend needs to render — the church name and the
      // finance currency. RLS returns only `is_public` rows to a caller without
      // settings.view, so this exposes nothing privileged. Loaded here, at session
      // establishment, rather than on every request.
      client.from('settings').select('key, value').eq('is_public', true),
    ]);

    if (profileResult.error) {
      throw unauthenticated('Your session could not be verified. Please sign in again.', {
        cause: profileResult.error,
      });
    }

    const profile = profileResult.data;
    if (!profile) {
      // An auth user with no profile row is a provisioning bug, not a login.
      // Treated as unauthenticated rather than 500: there is nothing the caller
      // can do, and we must not confirm that the credential itself was valid.
      throw unauthenticated('Your account is not set up. Contact an administrator.');
    }
    if (!profile.is_active) {
      throw unauthenticated('This account has been deactivated.');
    }

    const grants = (permissionResult.data ?? []).map((row) => ({
      permissionKey: row.permission_key,
      branchId: row.branch_id ?? null,
    }));

    // A failure here must not deny the session: someone who leads nothing is the
    // common case, and an error would be indistinguishable from it. The list is
    // additive authority, so an empty list is the safe reading.
    const ledMinistryIds = (ledResult.data ?? [])
      .map((row) => (typeof row === 'string' ? row : row.my_led_ministry_ids))
      .filter(Boolean);

    // A settings read failure must not deny the session: the values are for
    // display and each has a sensible frontend default. An empty map is the safe
    // reading, same as the leadership list above.
    const settingsRows = settingsResult.error ? [] : (settingsResult.data ?? []);
    const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));

    return {
      userId: profile.id,
      fullName: profile.full_name,
      defaultBranchId: profile.default_branch_id ?? null,
      isActive: true,
      permissions: createPermissionSet(grants),
      ledMinistryIds,
      settings,
    };
  };
}
