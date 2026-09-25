/**
 * User-account and role-grant data access.
 *
 * Two clients are used here on purpose:
 *
 *   - The USER client (RLS applies) for everything a permission already governs:
 *     listing and reading profiles, editing them, toggling activation, reading the
 *     role catalogue, and granting or revoking role grants. The database policies
 *     and the escalation triggers are the real authority; this module only shapes
 *     the queries.
 *   - The ADMIN client (service-role, RLS bypassed) for exactly one thing:
 *     provisioning. There is no `auth.users` trigger that creates a profile and no
 *     INSERT policy on `profiles`, so a new account has to be created in two steps
 *     only the service role can perform — create the auth user, then insert the
 *     profile — with a rollback if the second step fails, so a half-made account
 *     never lingers.
 *
 * `granted_by` is stamped from the caller's own id, never taken from the client:
 * the row must always say who really issued the grant.
 */

import { createAdminClient } from '../data/supabase-admin.js';
import { createUserClient } from '../data/supabase-user.js';
import { mapDatabaseError, unwrap } from '../data/errors.js';
import { conflict, internalError, notFound } from '../lib/errors.js';

// A profile embeds its role grants. `user_roles` has two foreign keys back to
// `profiles` (`user_id` and `granted_by`), so the embed is ambiguous unless the
// relationship is named — hence the `!user_roles_user_id_fkey` hint.
const LIST_COLUMNS = `
  id, full_name, is_active, default_branch_id, last_login_at,
  user_roles!user_roles_user_id_fkey ( branch_id, roles ( key, name ) )
`
  .replace(/\s+/g, ' ')
  .trim();

const DETAIL_COLUMNS = `
  id, full_name, phone, avatar_path, default_branch_id, is_active,
  last_login_at, created_at, updated_at,
  user_roles!user_roles_user_id_fkey ( id, role_id, branch_id, granted_at, roles ( id, key, name ) )
`
  .replace(/\s+/g, ' ')
  .trim();

const ROLE_COLUMNS = 'id, key, name, description, is_system, sort_order';

// The single grant returned after assigning a role. `roles` is a single relation
// here, so this embed is unambiguous and needs no hint.
const GRANT_COLUMNS = 'id, role_id, branch_id, granted_at, roles ( key, name )';

export function escapeLikePattern(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * Whether a GoTrue invite failure means the email is already registered. GoTrue
 * has changed the exact error shape over time, so match on any of the signals
 * rather than a single field.
 */
function isEmailAlreadyRegistered(error) {
  const code = error?.code ?? error?.error_code ?? '';
  const message = (error?.message ?? '').toLowerCase();
  return (
    code === 'email_exists' ||
    error?.status === 422 ||
    message.includes('already been registered') ||
    message.includes('already registered') ||
    message.includes('already exists')
  );
}

export function createUsersService({
  getClient = createUserClient,
  getAdminClient = createAdminClient,
} = {}) {
  async function list({ accessToken, search, isActive, branchId, sort, pagination }) {
    let query = getClient(accessToken).from('profiles').select(LIST_COLUMNS, { count: 'exact' });

    if (search) query = query.ilike('full_name', `%${escapeLikePattern(search)}%`);
    if (isActive !== undefined) query = query.eq('is_active', isActive);
    if (branchId) query = query.eq('default_branch_id', branchId);

    query = query
      .order(sort.column, { ascending: sort.ascending })
      .order('id', { ascending: true })
      .range(pagination.from, pagination.to);

    const result = await query;
    const rows = unwrap(result, { resource: 'user' });

    return { rows: rows ?? [], total: result.count ?? null };
  }

  async function get({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('profiles')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    const row = unwrap(result, { resource: 'user' });
    if (!row) throw notFound('That user does not exist.');
    return row;
  }
  /**
   * Provision a new account: create the auth user, then insert its profile. The
   * two must succeed together, so a failed profile insert rolls back the orphaned
   * auth user. Runs on the service-role client — the one path that legitimately
   * bypasses RLS, because there is no profiles INSERT policy and no auth trigger.
   */
  async function invite({ email, fullName, defaultBranchId = null, redirectTo }) {
    const admin = getAdminClient();

    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
      redirectTo,
    });

    if (error) {
      if (isEmailAlreadyRegistered(error)) {
        throw conflict('A user with that email address already exists.', { cause: error });
      }
      throw internalError('Could not send that invitation.', { cause: error });
    }

    const authUserId = data?.user?.id;
    if (!authUserId) {
      throw internalError('The invitation did not return a new user id.');
    }

    const result = await admin
      .from('profiles')
      .insert({ id: authUserId, full_name: fullName, default_branch_id: defaultBranchId })
      .select(DETAIL_COLUMNS)
      .single();

    if (result.error) {
      // The auth user now exists with no profile: it can never sign in usefully,
      // so remove it rather than leave a half-made account. Best effort — if the
      // cleanup itself fails, the original insert error is still what the caller hears.
      try {
        await admin.auth.admin.deleteUser(authUserId);
      } catch {
        // Swallowed on purpose; the mapped insert error below is the real story.
      }
      throw mapDatabaseError(result.error, { resource: 'user' });
    }

    return result.data;
  }

  async function update({ accessToken, id, patch }) {
    const result = await getClient(accessToken)
      .from('profiles')
      .update(patch)
      .eq('id', id)
      .select(DETAIL_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'user' });
    if (!row) throw notFound('That user does not exist.');
    return row;
  }
  /**
   * Toggle activation. The `profiles_guard_update` trigger requires the
   * `users.deactivate` permission when `is_active` actually changes, so a plain
   * profile editor cannot flip it — the trigger, not this method, is the guard.
   */
  async function setActive({ accessToken, id, isActive }) {
    const result = await getClient(accessToken)
      .from('profiles')
      .update({ is_active: isActive })
      .eq('id', id)
      .select(DETAIL_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'user' });
    if (!row) throw notFound('That user does not exist.');
    return row;
  }

  /** The role catalogue. Readable under `users.view` as well as `roles.manage`. */
  async function listRoles({ accessToken }) {
    const result = await getClient(accessToken)
      .from('roles')
      .select(ROLE_COLUMNS)
      .order('sort_order', { ascending: true })
      .order('key', { ascending: true });

    return unwrap(result, { resource: 'role' }) ?? [];
  }

  /**
   * Grant a role. `granted_by` is stamped from the caller, never the client. The
   * escalation guards (no self-grant, no handing out authority you lack) live in
   * the database trigger; this only issues the insert.
   */
  async function grantRole({ accessToken, userId, roleId, branchId = null, grantedBy }) {
    const result = await getClient(accessToken)
      .from('user_roles')
      .insert({ user_id: userId, role_id: roleId, branch_id: branchId, granted_by: grantedBy })
      .select(GRANT_COLUMNS)
      .single();

    return unwrap(result, { resource: 'role grant' });
  }

  /**
   * Revoke a grant, scoped by both its id and the user it belongs to, so a grant
   * id from one user can never strip another. The last-active-super-admin
   * protection is a database trigger.
   */
  async function revokeRole({ accessToken, userId, grantId }) {
    const result = await getClient(accessToken)
      .from('user_roles')
      .delete()
      .eq('id', grantId)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle();

    const row = unwrap(result, { resource: 'role grant' });
    if (!row) throw notFound('That role grant does not exist.');
    return row;
  }

  return {
    list,
    get,
    invite,
    update,
    setActive,
    listRoles,
    grantRole,
    revokeRole,
  };
}
