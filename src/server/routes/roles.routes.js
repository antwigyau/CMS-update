/**
 * Role-administration endpoints.
 *
 *   GET    /api/admin/roles                    the role roster, with counts
 *   POST   /api/admin/roles                    create a custom role
 *   GET    /api/admin/roles/permissions        the permission catalogue (for the editor)
 *   GET    /api/admin/roles/:id                one role, with its permission ids
 *   PATCH  /api/admin/roles/:id                edit a role's name / description / order
 *   PUT    /api/admin/roles/:id/permissions    replace a role's permission set
 *   DELETE /api/admin/roles/:id                delete an unused, non-system role
 *
 * `roles.manage` is a global permission (seeded with a null branch), so the
 * unscoped `context.can(...)` is the right question and every route is gated on it
 * directly — there is no branch-scoped or leadership path here.
 *
 * **Every guard here is a mirror.** RLS on `roles`, `permissions`, and
 * `role_permissions` is the real authority, and the `roles_protect_system*`
 * triggers protect the seeded roles regardless of what these handlers allow. Two
 * protections are, however, enforced *here* and nowhere else:
 *
 *   - A role that is still granted to anyone cannot be deleted. The FK would trip
 *     (a misleading "linked records" error), so the handler pre-checks the grant
 *     count and refuses with a written message instead.
 *   - When permissions are added to a role, the acting admin must themselves hold
 *     each added permission. The database gates `role_permissions` on `roles.manage`
 *     alone — it does not check this — so without the guard a delegated role manager
 *     could give a role authority they lack, then take that role. A no-op today
 *     (only super_admin holds `roles.manage`, and it holds everything), it closes
 *     the escalation the moment `roles.manage` is delegated.
 */

import { conflict, forbidden, validationFailed } from '../../lib/errors.js';
import { created, noContent, ok } from '../../lib/http.js';
import { validate } from '../../validation/index.js';
import {
  roleCreateSchema,
  rolePermissionsSchema,
  roleUpdateSchema,
  toPermissionView,
  toRoleDetailView,
  toRoleListView,
  toRoleRow,
  toRoleView,
} from '../../validation/roles.schemas.js';

export function registerRolesRoutes(router, { roles, audit }) {
  /* ---- list ------------------------------------------------------------- */

  async function list(context) {
    const rows = await roles.list({ accessToken: context.session.accessToken });
    return ok(rows.map(toRoleListView));
  }

  /* ---- permission catalogue --------------------------------------------- */

  async function listPermissions(context) {
    const rows = await roles.listPermissions({ accessToken: context.session.accessToken });
    return ok(rows.map(toPermissionView));
  }

  /* ---- create ----------------------------------------------------------- */

  async function create(context) {
    const input = validate(roleCreateSchema, await context.json());

    const row = await roles.create({
      accessToken: context.session.accessToken,
      row: toRoleRow(input),
    });

    await audit.record(context, {
      action: 'role.created',
      resourceType: 'role',
      resourceId: row.id,
      changes: { key: row.key },
    });

    return created(toRoleView(row), { location: `/api/admin/roles/${row.id}` });
  }

  /* ---- read ------------------------------------------------------------- */

  async function read(context) {
    const row = await roles.get({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });
    return ok(toRoleDetailView(row));
  }

  /* ---- update ----------------------------------------------------------- */

  async function update(context) {
    const input = validate(roleUpdateSchema, await context.json());

    const row = await roles.update({
      accessToken: context.session.accessToken,
      id: context.params.id,
      patch: toRoleRow(input),
    });

    await audit.record(context, {
      action: 'role.updated',
      resourceType: 'role',
      resourceId: row.id,
      changes: { fields: Object.keys(input).sort() },
    });

    return ok(toRoleView(row));
  }

  /* ---- permissions ------------------------------------------------------ */

  async function setPermissions(context) {
    const { permissionIds } = validate(rolePermissionsSchema, await context.json());
    const accessToken = context.session.accessToken;
    const id = context.params.id;

    const role = await roles.get({ accessToken, id });

    // Diff the desired set against what the role already carries. `permissionIds`
    // is de-duped by the Set; a repeated id cannot inflate the add list.
    const desired = new Set(permissionIds);
    const current = new Set(toRoleDetailView(role).permissionIds);
    const addIds = [...desired].filter((pid) => !current.has(pid));
    const removeIds = [...current].filter((pid) => !desired.has(pid));

    // Nothing changed: report the role as it stands rather than write an empty diff.
    if (addIds.length === 0 && removeIds.length === 0) {
      return ok(toRoleDetailView(role));
    }

    const catalogue = await roles.listPermissions({ accessToken });
    const keyById = new Map(catalogue.map((permission) => [permission.id, permission.key]));

    // Escalation guard: you cannot hand a role authority you do not hold yourself.
    // Removals are always allowed. See the module comment for why this lives here.
    for (const pid of addIds) {
      const key = keyById.get(pid);
      if (!key) {
        throw validationFailed('Some of the information you entered needs correcting.', {
          details: { fields: { permissionIds: 'One of those permissions does not exist.' } },
        });
      }
      if (!context.can(key)) {
        throw forbidden(`You cannot add the permission "${key}", which you do not hold.`);
      }
    }

    await roles.applyPermissionChanges({ accessToken, id, addIds, removeIds });

    // Audit carries permission *keys*, never ids — legible and PII-free.
    const toKeys = (ids) => ids.map((pid) => keyById.get(pid) ?? pid).sort();
    await audit.record(context, {
      action: 'role.permissions_updated',
      resourceType: 'role',
      resourceId: id,
      changes: { added: toKeys(addIds), removed: toKeys(removeIds) },
    });

    const fresh = await roles.get({ accessToken, id });
    return ok(toRoleDetailView(fresh));
  }

  /* ---- delete ----------------------------------------------------------- */

  async function remove(context) {
    const accessToken = context.session.accessToken;
    const id = context.params.id;

    const role = await roles.get({ accessToken, id });

    // A seeded role is part of the permission model. The trigger refuses it too,
    // but as a generic conflict — say plainly what happened.
    if (role.is_system) {
      throw conflict('A system role cannot be deleted.');
    }

    // A role still granted to someone cannot be deleted without stripping access.
    // The FK (on delete restrict) is the backstop; this is the legible version.
    const { grantCount } = toRoleDetailView(role);
    if (grantCount > 0) {
      throw conflict(
        `This role is assigned to ${grantCount} account${
          grantCount === 1 ? '' : 's'
        }. Revoke those grants first.`,
      );
    }

    await roles.remove({ accessToken, id });

    await audit.record(context, {
      action: 'role.deleted',
      resourceType: 'role',
      resourceId: id,
      changes: { key: role.key },
    });

    return noContent();
  }

  /* ---- registration ----------------------------------------------------- */

  router.get('/admin/roles', list, { permission: 'roles.manage' });
  router.post('/admin/roles', create, { permission: 'roles.manage' });
  // The literal must be registered before `/admin/roles/:id`, or "permissions"
  // would be read as an id and captured by the parameter route first.
  router.get('/admin/roles/permissions', listPermissions, { permission: 'roles.manage' });
  router.get('/admin/roles/:id', read, { permission: 'roles.manage' });
  router.patch('/admin/roles/:id', update, { permission: 'roles.manage' });
  router.put('/admin/roles/:id/permissions', setPermissions, { permission: 'roles.manage' });
  router.delete('/admin/roles/:id', remove, { permission: 'roles.manage' });
}
