/**
 * User-administration endpoints.
 *
 *   GET    /api/admin/users                       list, search, paginate profiles
 *   POST   /api/admin/users                       invite a new account
 *   GET    /api/admin/users/roles                 the role catalogue
 *   GET    /api/admin/users/:id                   one profile, with capability flags
 *   PATCH  /api/admin/users/:id                   edit a profile
 *   POST   /api/admin/users/:id/active            activate / deactivate
 *   POST   /api/admin/users/:id/roles             grant a role
 *   DELETE /api/admin/users/:id/roles/:grantId    revoke a grant
 *
 * There is deliberately **no DELETE for a user**. An account with history is
 * deactivated, not removed — deleting the auth user would cascade through every
 * record that references it. The database has no profiles delete policy either.
 *
 * **Every guard here is a mirror.** The real authority is in the database: RLS on
 * `profiles`, `roles`, and `user_roles`, plus escalation triggers —
 * `profiles_guard_update` (activation needs `users.deactivate`) and
 * `user_roles_guard_*` (no self-grant, no granting authority you lack, never remove
 * the last active Super Administrator). The refusals below are the legible,
 * before-the-round-trip version of rules the database enforces regardless.
 *
 * **Self-service is refused early.** A user cannot change their own activation or
 * their own role grants; the trigger raises `insufficient_privilege` (a generic
 * 403), so catching it here first gives a message that says what happened while
 * the trigger stays the non-bypassable backstop.
 *
 * The invite `redirectTo` reuses the reset-password page: an invited user follows
 * the link to set their initial password (a dedicated invite-acceptance page is
 * deferred — see the completion report).
 */

import { config } from '../../config/env.js';
import { forbidden } from '../../lib/errors.js';
import { created, noContent, ok } from '../../lib/http.js';
import { buildPageMeta, readPagination, readSort } from '../../lib/pagination.js';
import { validate } from '../../validation/index.js';
import {
  USER_SORTS,
  roleGrantSchema,
  toGrantView,
  toRoleView,
  toUserListView,
  toUserRow,
  toUserView,
  userActiveSchema,
  userInviteSchema,
  userUpdateSchema,
} from '../../validation/users.schemas.js';

/** `?active=true|false` narrows the list; anything else lists everyone. */
function readActive(query) {
  const value = query.get('active')?.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function registerUsersRoutes(router, { users, audit }) {
  /* ---- list ------------------------------------------------------------- */

  async function list(context) {
    const pagination = readPagination(context.query);
    const sort = readSort(context.query.get('sort') ?? 'name', USER_SORTS, 'name');

    const { rows, total } = await users.list({
      accessToken: context.session.accessToken,
      search: context.query.get('search')?.trim() || undefined,
      isActive: readActive(context.query),
      branchId: context.query.get('branchId') || undefined,
      sort,
      pagination,
    });

    return ok(rows.map(toUserListView), {
      ...buildPageMeta({ page: pagination.page, pageSize: pagination.pageSize, total }),
      sort: sort.key,
      ascending: sort.ascending,
    });
  }

  /* ---- invite ----------------------------------------------------------- */

  async function invite(context) {
    const input = validate(userInviteSchema, await context.json());

    const user = await users.invite({
      email: input.email,
      fullName: input.fullName,
      defaultBranchId: input.defaultBranchId ?? null,
      redirectTo: `${config.appUrl}/reset-password`,
    });

    context.logger.info('user invited', { userId: user.id });
    await audit.record(context, {
      action: 'user.invited',
      resourceType: 'user',
      resourceId: user.id,
      branchId: input.defaultBranchId ?? null,
      changes: { email: input.email },
    });

    return created(toUserView(user), { location: `/api/admin/users/${user.id}` });
  }
  /* ---- roles catalogue -------------------------------------------------- */

  async function listRoles(context) {
    const rows = await users.listRoles({ accessToken: context.session.accessToken });
    return ok(rows.map(toRoleView));
  }

  /* ---- read ------------------------------------------------------------- */

  /**
   * Capability flags, always booleans. `users.*` permissions are global (branch
   * id null in the seed), so the unscoped `context.can(...)` is the right question.
   * A user is never offered the controls to change their own activation or grants.
   */
  function capabilities(context, user) {
    const isSelf = user.id === context.session.userId;
    return {
      canUpdate: context.can('users.update'),
      canDeactivate: context.can('users.deactivate') && !isSelf,
      canManageRoles: context.can('users.roles.manage') && !isSelf,
    };
  }

  async function read(context) {
    const user = await users.get({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });

    return ok({ ...toUserView(user), ...capabilities(context, user) });
  }

  /* ---- update ----------------------------------------------------------- */

  async function update(context) {
    const input = validate(userUpdateSchema, await context.json());

    const user = await users.update({
      accessToken: context.session.accessToken,
      id: context.params.id,
      patch: toUserRow(input),
    });

    context.logger.info('user updated', { userId: user.id, fields: Object.keys(input).sort() });
    await audit.record(context, {
      action: 'user.updated',
      resourceType: 'user',
      resourceId: user.id,
      branchId: user.default_branch_id ?? null,
      changes: { fields: Object.keys(input).sort() },
    });

    return ok(toUserView(user));
  }
  /* ---- activation ------------------------------------------------------- */

  async function setActive(context) {
    const { isActive } = validate(userActiveSchema, await context.json());

    // The trigger refuses a self-change too, but as a generic 403. Say what happened.
    if (context.params.id === context.session.userId) {
      context.logger.warn('self activation change refused', { userId: context.params.id });
      throw forbidden('You cannot change your own account activation.');
    }

    const user = await users.setActive({
      accessToken: context.session.accessToken,
      id: context.params.id,
      isActive,
    });

    context.logger.info('user activation changed', { userId: user.id, isActive });
    await audit.record(context, {
      action: isActive ? 'user.activated' : 'user.deactivated',
      resourceType: 'user',
      resourceId: user.id,
      branchId: user.default_branch_id ?? null,
      changes: { isActive },
    });

    return ok(toUserView(user));
  }

  /* ---- role grants ------------------------------------------------------ */

  async function grantRole(context) {
    const input = validate(roleGrantSchema, await context.json());
    const targetId = context.params.id;

    if (targetId === context.session.userId) {
      context.logger.warn('self role grant refused', { userId: targetId });
      throw forbidden('You cannot change your own role grants.');
    }

    const grant = await users.grantRole({
      accessToken: context.session.accessToken,
      userId: targetId,
      roleId: input.roleId,
      branchId: input.branchId ?? null,
      grantedBy: context.session.userId,
    });

    context.logger.info('role granted', { userId: targetId, grantId: grant.id });
    await audit.record(context, {
      action: 'user.role_granted',
      resourceType: 'user',
      resourceId: targetId,
      branchId: input.branchId ?? null,
      changes: { roleId: input.roleId, grantId: grant.id },
    });

    return created(toGrantView(grant), {
      location: `/api/admin/users/${targetId}/roles/${grant.id}`,
    });
  }
  async function revokeRole(context) {
    const targetId = context.params.id;

    if (targetId === context.session.userId) {
      context.logger.warn('self role revoke refused', { userId: targetId });
      throw forbidden('You cannot change your own role grants.');
    }

    await users.revokeRole({
      accessToken: context.session.accessToken,
      userId: targetId,
      grantId: context.params.grantId,
    });

    context.logger.info('role revoked', { userId: targetId, grantId: context.params.grantId });
    await audit.record(context, {
      action: 'user.role_revoked',
      resourceType: 'user',
      resourceId: targetId,
      changes: { grantId: context.params.grantId },
    });

    return noContent();
  }

  /* ---- registration ----------------------------------------------------- */

  router.get('/admin/users', list, { permission: 'users.view' });
  router.post('/admin/users', invite, { permission: 'users.invite' });
  // The literal must be registered before `/admin/users/:id`, or "roles" would be
  // read as an id and matched by the parameter route first.
  router.get('/admin/users/roles', listRoles, { permission: 'users.view' });
  router.get('/admin/users/:id', read, { permission: 'users.view' });
  router.patch('/admin/users/:id', update, { permission: 'users.update' });
  router.post('/admin/users/:id/active', setActive, { permission: 'users.deactivate' });
  router.post('/admin/users/:id/roles', grantRole, { permission: 'users.roles.manage' });
  router.delete('/admin/users/:id/roles/:grantId', revokeRole, {
    permission: 'users.roles.manage',
  });
}
