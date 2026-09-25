/**
 * Role and role-permission payload validation.
 *
 * Kept in step with the database in `20260826120300_identity_and_rbac.sql` and its
 * RLS in `20260826120500_identity_and_rbac_rls.sql`. The real enforcement lives
 * there: the `roles_key_format` / `roles_name_length` check constraints, the unique
 * `roles_key_key`, and the `roles_protect_system*` triggers (a system role cannot be
 * deleted, and its `key`/`is_system` cannot change). These schemas mirror the shape
 * rules so a mistake becomes a field-attributed 422 rather than a raw database error.
 *
 * Two things are deliberately NOT accepted from the client:
 *   - `isSystem` — the database defaults it false; a role is only ever "system" by
 *     being seeded, never by a form.
 *   - `key` on an update — a role's key is its stable identifier, chosen once at
 *     creation. Making it immutable keeps the schema simple and, as a bonus, makes
 *     the system-role-key trigger unreachable through the API.
 */

import { z } from 'zod';

/** Mirrors `roles_key_format`: a lowercase letter, then 2–39 of [a-z0-9_]. */
const key = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]{2,39}$/,
    'Start with a lowercase letter; 3–40 lowercase letters, digits or underscores.',
  );

/** 2–60 characters, matching the `roles_name_length` constraint. */
const name = z
  .string()
  .trim()
  .min(2, 'Enter a name of at least 2 characters.')
  .max(60, 'That name is too long.');

/** Optional free text; a cleared field becomes null rather than "". */
const description = z
  .string()
  .trim()
  .max(500, 'Keep the description to 500 characters or fewer.')
  .transform((value) => (value === '' ? null : value))
  .nullish();

/** A smallint display-order hint. Lower sorts first. */
const sortOrder = z
  .number({ message: 'Enter a sort order.' })
  .int('Enter a whole number.')
  .min(0, 'Enter a number of 0 or more.')
  .max(32767, 'That number is too large.');

const roleFields = { key, name, description, sortOrder };

/**
 * Create a role. `sortOrder` defaults to 100 (the database default) so the form
 * need not send it. `isSystem` is absent — see the module comment.
 */
export const roleCreateSchema = z
  .object({ ...roleFields, sortOrder: sortOrder.default(100) })
  .strict();

/**
 * Edit a role. `key` is omitted (immutable), and at least one field must be
 * present, so an empty PATCH is a 422 rather than a silent no-op.
 */
export const roleUpdateSchema = z
  .object(roleFields)
  .omit({ key: true })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' });

/**
 * Replace a role's permission set. The handler diffs this against what the role
 * already holds; the cap is a guard against an absurd payload, not a real limit.
 */
export const rolePermissionsSchema = z
  .object({
    permissionIds: z
      .array(z.string().uuid('That is not a valid permission.'))
      .max(200, 'That is more permissions than exist.'),
  })
  .strict();

/** `[{ count }]` from an embedded aggregate, tolerating a missing embed. */
function embeddedCount(value) {
  return Array.isArray(value) ? (value[0]?.count ?? 0) : 0;
}

/**
 * Payload -> role row. Undefined keys are dropped so a PATCH touches only what was
 * sent. Never writes `id`, `is_system`, or any timestamp column.
 */
export function toRoleRow(input) {
  const columns = {
    key: input.key,
    name: input.name,
    description: input.description,
    sort_order: input.sortOrder,
  };

  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

export function toRoleView(row) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    isSystem: row.is_system,
    sortOrder: row.sort_order,
  };
}

/** The roster row: the role plus how many permissions it carries and users hold it. */
export function toRoleListView(row) {
  return {
    ...toRoleView(row),
    permissionCount: embeddedCount(row.role_permissions),
    grantCount: embeddedCount(row.user_roles),
  };
}

/** The editor row: the role, the ids of the permissions it carries, and its use. */
export function toRoleDetailView(row) {
  return {
    ...toRoleView(row),
    permissionIds: (row.role_permissions ?? []).map((entry) => entry.permission_id),
    grantCount: embeddedCount(row.user_roles),
  };
}

/** One entry in the permission catalogue, grouped by its first dotted segment. */
export function toPermissionView(row) {
  return {
    id: row.id,
    key: row.key,
    resource: row.resource,
    action: row.action,
    description: row.description,
    group: row.group_key,
  };
}
