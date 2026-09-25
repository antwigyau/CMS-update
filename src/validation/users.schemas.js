/**
 * User-account and role-grant payload validation.
 *
 * Kept in step with the database in `20260826120300_identity_and_rbac.sql` and its
 * RLS in `20260826120500_identity_and_rbac_rls.sql`. The real enforcement lives
 * there: the `profiles_*` check constraints, the `profiles_guard_update` trigger
 * (activation needs `users.deactivate`), and the `user_roles_guard_*` triggers
 * (no self-grant, no privilege escalation, never remove the last Super
 * Administrator). These schemas mirror the shape rules so a mistake becomes a
 * field-attributed 422 rather than a raw database error — they are a courtesy, not
 * the guard.
 *
 * Two things are deliberately NOT accepted from the client:
 *   - `isActive` on the profile update — activation is its own endpoint and its own
 *     permission (`users.deactivate`), so it cannot ride in on an edit.
 *   - `id` anywhere — a profile's id is its auth user's id, set at provisioning,
 *     never chosen by a form.
 */

import { z } from 'zod';

/** Mirrors `app.is_valid_phone`: digits, spaces, and the usual separators. */
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()./-]{6,19}$/, 'Enter a valid phone number.')
  .transform((value) => (value === '' ? null : value))
  .nullish();

/** A required email, trimmed and lowercased. Mirrors `app.is_valid_email`. */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Enter an email address.')
  .max(254, 'That email address is too long.')
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'Enter a valid email address.');

/** 2–120 characters, matching the `profiles_full_name_length` constraint. */
const fullName = z
  .string()
  .trim()
  .min(2, 'Enter a name of at least 2 characters.')
  .max(120, 'That name is too long.');

/** A branch id, or null to mean "no default branch" / "in every branch". */
const branchId = z.string().uuid('Choose a branch.').nullish();

/**
 * Invite a new account. The service creates the auth user and the profile
 * together; the caller supplies only who they are, not an id or a password.
 */
export const userInviteSchema = z
  .object({
    email,
    fullName,
    defaultBranchId: branchId,
  })
  .strict();

const userFields = {
  fullName,
  phone,
  defaultBranchId: branchId,
};

/**
 * Edit a profile. `isActive` and `id` are both absent (see the module comment).
 * At least one field must be present, so an empty PATCH is a 422 rather than a
 * silent no-op.
 */
export const userUpdateSchema = z
  .object(userFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' });

/** The activation endpoint carries exactly one field. */
export const userActiveSchema = z
  .object({ isActive: z.boolean({ message: 'Choose whether the account is active.' }) })
  .strict();

/**
 * Grant a role. `branchId` null means the grant applies in every branch — that is
 * how a Super Administrator or Senior Pastor is represented, rather than by a
 * special case in code.
 */
export const roleGrantSchema = z
  .object({
    roleId: z.string().uuid('Choose a role.'),
    branchId,
  })
  .strict();

export const USER_SORTS = Object.freeze({
  name: 'full_name',
  created: 'created_at',
  lastLogin: 'last_login_at',
});

/**
 * Payload -> profile row. Undefined keys are dropped so a PATCH touches only what
 * was sent. Never writes `id`, `is_active`, or any timestamp column.
 */
export function toUserRow(input) {
  const columns = {
    full_name: input.fullName,
    phone: input.phone,
    default_branch_id: input.defaultBranchId,
  };

  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

/** The role grants embedded on a profile, tolerating a missing/empty embed. */
function mapGrants(row) {
  return (row.user_roles ?? []).map((grant) => ({
    id: grant.id,
    roleId: grant.role_id,
    branchId: grant.branch_id,
    grantedAt: grant.granted_at,
    roleKey: grant.roles?.key ?? null,
    roleName: grant.roles?.name ?? null,
  }));
}

export function toUserView(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone ?? null,
    avatarPath: row.avatar_path ?? null,
    defaultBranchId: row.default_branch_id ?? null,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    roles: mapGrants(row),
  };
}

export function toUserListView(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    isActive: row.is_active,
    defaultBranchId: row.default_branch_id ?? null,
    lastLoginAt: row.last_login_at ?? null,
    roles: (row.user_roles ?? []).map((grant) => ({
      roleKey: grant.roles?.key ?? null,
      roleName: grant.roles?.name ?? null,
      branchId: grant.branch_id,
    })),
  };
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

/** The single grant returned when a role is assigned. */
export function toGrantView(row) {
  return {
    id: row.id,
    roleId: row.role_id,
    branchId: row.branch_id,
    grantedAt: row.granted_at,
    roleKey: row.roles?.key ?? null,
    roleName: row.roles?.name ?? null,
  };
}
