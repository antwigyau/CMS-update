/**
 * Role-shaped fixtures.
 *
 * Raw snake_case rows, matching the columns the roles service selects, as the
 * query recorder would hand them back. The list and detail rows carry the same
 * embedded aggregates PostgREST returns for `role_permissions(...)` and
 * `user_roles(count)`, so the view mappers are exercised on realistic shapes.
 */

export const ROLE_ID = 'e5e5e5e5-5555-4555-8555-555555555555';

// Permission-catalogue ids. Real UUIDs, because `permissionIds` is validated as a
// list of them — an invented string would turn every request into a 422.
export const PERM_ROLES_MANAGE = 'd4d4d4d4-4444-4444-8444-444444444444';
export const PERM_MEMBERS_VIEW = 'a1a1a1a1-1111-4111-8111-111111111111';
export const PERM_EVENTS_VIEW = 'b2b2b2b2-2222-4222-8222-222222222222';
export const PERM_FINANCE_APPROVE = 'c3c3c3c3-3333-4333-8333-333333333333';
export const PERM_UNKNOWN = 'f6f6f6f6-6666-4666-8666-666666666666';

/** The base columns echoed back after a create or an update. */
export function roleRow(overrides = {}) {
  return {
    id: ROLE_ID,
    key: 'finance_officer',
    name: 'Finance officer',
    description: 'Records and submits finance entries.',
    is_system: false,
    sort_order: 100,
    ...overrides,
  };
}

/** A roster row: the role plus the embedded permission and grant counts. */
export function roleListRow(overrides = {}) {
  return {
    id: ROLE_ID,
    key: 'finance_officer',
    name: 'Finance officer',
    description: 'Records and submits finance entries.',
    is_system: false,
    sort_order: 100,
    role_permissions: [{ count: 4 }],
    user_roles: [{ count: 2 }],
    ...overrides,
  };
}

/** An editor row: the role, the ids of the permissions it carries, and its use. */
export function roleDetailRow(overrides = {}) {
  return {
    id: ROLE_ID,
    key: 'finance_officer',
    name: 'Finance officer',
    description: 'Records and submits finance entries.',
    is_system: false,
    sort_order: 100,
    role_permissions: [{ permission_id: PERM_ROLES_MANAGE }],
    user_roles: [{ count: 0 }],
    ...overrides,
  };
}

/** One entry in the permission catalogue. Defaults to `members.view`. */
export function permissionRow(overrides = {}) {
  return {
    id: PERM_MEMBERS_VIEW,
    key: 'members.view',
    resource: 'members',
    action: 'view',
    description: 'View member records',
    group_key: 'members',
    ...overrides,
  };
}

/** The catalogue used by the permission-editor tests, keyed to the ids above. */
export function permissionCatalogue() {
  return [
    permissionRow({
      id: PERM_ROLES_MANAGE,
      key: 'roles.manage',
      resource: 'roles',
      action: 'manage',
      description: 'Manage roles and their permissions',
      group_key: 'roles',
    }),
    permissionRow({ id: PERM_MEMBERS_VIEW, key: 'members.view' }),
    permissionRow({
      id: PERM_EVENTS_VIEW,
      key: 'events.view',
      resource: 'events',
      action: 'view',
      description: 'View events',
      group_key: 'events',
    }),
    permissionRow({
      id: PERM_FINANCE_APPROVE,
      key: 'finance.approve',
      resource: 'finance',
      action: 'approve',
      description: 'Approve finance transactions',
      group_key: 'finance',
    }),
  ];
}
