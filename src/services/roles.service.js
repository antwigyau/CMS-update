/**
 * Role and role-permission data access.
 *
 * The USER client only (RLS applies). The database is the real authority: the
 * `roles_write` / `role_permissions_write` policies gate every mutation on
 * `roles.manage`, and the `roles_protect_system*` triggers protect the seeded
 * roles. This module only shapes the queries — it never bypasses RLS, so there is
 * no admin/service-role client here.
 *
 * Methods return raw snake_case rows; mapping to the camelCase view shapes is the
 * routes layer's job (`roles.schemas.js`).
 */

import { createUserClient } from '../data/supabase-user.js';
import { unwrap } from '../data/errors.js';
import { notFound } from '../lib/errors.js';

// A role, plus a count of the permissions it carries and the grants that use it.
// Both embeds are unambiguous: `role_permissions` and `user_roles` each have a
// single foreign key back to `roles`.
const LIST_COLUMNS =
  'id, key, name, description, is_system, sort_order, role_permissions(count), user_roles(count)';

// The editor needs the actual permission ids to pre-check its boxes, and the grant
// count to decide whether the role may be deleted.
const DETAIL_COLUMNS =
  'id, key, name, description, is_system, sort_order, role_permissions(permission_id), user_roles(count)';

// The base columns, for the row echoed back after a create or an update.
const ROLE_COLUMNS = 'id, key, name, description, is_system, sort_order';

// The catalogue. `group_key` is generated (the first dotted segment) and groups the
// editor's checkboxes; `description` is the human label — there is no `name` column.
const PERMISSION_COLUMNS = 'id, key, resource, action, description, group_key';

export function createRolesService({ getClient = createUserClient } = {}) {
  /** The roster. The set is small and fixed, so there is no pagination. */
  async function list({ accessToken }) {
    const result = await getClient(accessToken)
      .from('roles')
      .select(LIST_COLUMNS)
      .order('sort_order', { ascending: true })
      .order('key', { ascending: true });

    return unwrap(result, { resource: 'role' }) ?? [];
  }

  /** The permission catalogue, ordered so the editor can group as it reads. */
  async function listPermissions({ accessToken }) {
    const result = await getClient(accessToken)
      .from('permissions')
      .select(PERMISSION_COLUMNS)
      .order('group_key', { ascending: true })
      .order('key', { ascending: true });

    return unwrap(result, { resource: 'permission' }) ?? [];
  }

  async function get({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('roles')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    const row = unwrap(result, { resource: 'role' });
    if (!row) throw notFound('That role does not exist.');
    return row;
  }

  async function create({ accessToken, row }) {
    const result = await getClient(accessToken)
      .from('roles')
      .insert(row)
      .select(ROLE_COLUMNS)
      .single();

    return unwrap(result, { resource: 'role' });
  }

  async function update({ accessToken, id, patch }) {
    const result = await getClient(accessToken)
      .from('roles')
      .update(patch)
      .eq('id', id)
      .select(ROLE_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'role' });
    if (!row) throw notFound('That role does not exist.');
    return row;
  }

  /**
   * Apply a permission diff: drop the removed rows, then add the new ones. Each
   * side is skipped when its list is empty. `role_permissions` cascades on the
   * role, so there is nothing to clean up beyond these two statements.
   */
  async function applyPermissionChanges({ accessToken, id, addIds, removeIds }) {
    const db = getClient(accessToken);

    if (removeIds.length > 0) {
      const removed = await db
        .from('role_permissions')
        .delete()
        .eq('role_id', id)
        .in('permission_id', removeIds);
      unwrap(removed, { resource: 'role permission' });
    }

    if (addIds.length > 0) {
      const added = await db
        .from('role_permissions')
        .insert(addIds.map((permissionId) => ({ role_id: id, permission_id: permissionId })));
      unwrap(added, { resource: 'role permission' });
    }
  }

  /** Delete the role. `role_permissions` cascades; `user_roles` restricts (the FK,
   * with the route's own pre-check, is the backstop against orphaning a grant). */
  async function remove({ accessToken, id }) {
    const result = await getClient(accessToken).from('roles').delete().eq('id', id);
    unwrap(result, { resource: 'role' });
  }

  return {
    list,
    listPermissions,
    get,
    create,
    update,
    applyPermissionChanges,
    remove,
  };
}
