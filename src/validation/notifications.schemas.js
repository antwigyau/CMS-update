/**
 * Notification payload validation and view mapping.
 *
 * Kept in step with `20260826121200_notifications_and_audit.sql`. The real
 * enforcement lives there: the `notifications_title_length` /
 * `notifications_body_length` / `notifications_link_relative` /
 * `notifications_expiry_after_publish` check constraints, and
 * `notifications_audience_role` (an `audience_role_id` is set if and only if the
 * audience is a role). These schemas mirror those rules so a mistake becomes a
 * field-attributed 422 rather than a raw database error.
 *
 * Two things are deliberately NOT accepted from the client:
 *   - `createdBy` — the acting user, stamped by the handler from the session.
 *   - the `user` audience and `event_reminder` type — a single-user direct
 *     message is out of scope, and event reminders are reserved for a future
 *     automated path, never hand-composed here.
 */

import { z } from 'zod';

/** 2–160 characters, matching `notifications_title_length`. */
const title = z
  .string()
  .trim()
  .min(2, 'Enter a title of at least 2 characters.')
  .max(160, 'Keep the title to 160 characters or fewer.');

/** 2–4000 characters, matching `notifications_body_length`. */
const body = z
  .string()
  .trim()
  .min(2, 'Enter a message of at least 2 characters.')
  .max(4000, 'Keep the message to 4000 characters or fewer.');

/** The composable types. `event_reminder` is reserved — see the module comment. */
const type = z.enum(['system', 'announcement', 'admin']).default('announcement');

const severity = z.enum(['info', 'warning', 'critical']).default('info');

/** The composable audiences. `user` (a direct message) is out of scope. */
const audience = z.enum(['all', 'role', 'branch']);

/** A relative deep link, mirroring `notifications_link_relative`; blank → null. */
const linkPath = z
  .string()
  .trim()
  .max(512, 'That link is too long.')
  .regex(/^\/[A-Za-z0-9._~/-]*$/, 'Enter a relative link that starts with /.')
  .transform((value) => (value === '' ? null : value))
  .nullish();

/** An ISO instant; the frontend sends `Date#toISOString()`. */
const expiresAt = z.string().datetime('Enter a valid date and time.').optional();

/**
 * Publish a notification. `audienceRoleId` / `branchId` are validated for
 * presence coherence against `audience` in the refinement below — the same rule
 * the `notifications_audience_role` constraint enforces, caught before the round
 * trip. `.strict()` is applied before `.superRefine`, since the refinement
 * produces a `ZodEffects` that has no `.strict()`.
 */
export const notificationCreateSchema = z
  .object({
    title,
    body,
    type,
    severity,
    audience,
    audienceRoleId: z.string().uuid('Choose a valid role.').optional(),
    branchId: z.string().uuid('Choose a valid branch.').optional(),
    linkPath,
    expiresAt,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.audience === 'role' && !value.audienceRoleId) {
      ctx.addIssue({
        code: 'custom',
        path: ['audienceRoleId'],
        message: 'Choose a role for a role-targeted notification.',
      });
    }
    if (value.audience !== 'role' && value.audienceRoleId) {
      ctx.addIssue({
        code: 'custom',
        path: ['audienceRoleId'],
        message: 'A role applies only to a role-targeted notification.',
      });
    }
    if (value.audience === 'branch' && !value.branchId) {
      ctx.addIssue({
        code: 'custom',
        path: ['branchId'],
        message: 'Choose a branch for a branch-targeted notification.',
      });
    }
    if (value.audience !== 'branch' && value.branchId) {
      ctx.addIssue({
        code: 'custom',
        path: ['branchId'],
        message: 'A branch applies only to a branch-targeted notification.',
      });
    }
  });

/** `[{ count }]` from an embedded aggregate, tolerating a missing embed. */
function embeddedCount(value) {
  return Array.isArray(value) ? (value[0]?.count ?? 0) : 0;
}

/**
 * Payload -> notification row. Undefined keys are dropped. `created_by` is set by
 * the handler from the session, never taken from the client.
 */
export function toNotificationRow(input) {
  const columns = {
    title: input.title,
    body: input.body,
    type: input.type,
    severity: input.severity,
    audience: input.audience,
    audience_role_id: input.audienceRoleId,
    branch_id: input.branchId,
    link_path: input.linkPath,
    expires_at: input.expiresAt,
  };

  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

/** The base notification, snake_case -> camelCase. */
export function toNotificationView(row) {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    audience: row.audience,
    audienceRoleId: row.audience_role_id ?? null,
    branchId: row.branch_id ?? null,
    linkPath: row.link_path ?? null,
    publishedAt: row.published_at,
    expiresAt: row.expires_at ?? null,
    createdBy: row.created_by ?? null,
  };
}

/** One inbox row: the notification plus the caller's read state from the join. */
export function toInboxView(row) {
  const recipient = Array.isArray(row.notification_recipients)
    ? row.notification_recipients[0]
    : null;
  const readAt = recipient?.read_at ?? null;

  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    linkPath: row.link_path ?? null,
    publishedAt: row.published_at,
    read: readAt !== null,
  };
}

/** A published-list row: the notification plus how many recipients it reached. */
export function toPublishedListView(row) {
  return {
    ...toNotificationView(row),
    recipientCount: embeddedCount(row.notification_recipients),
  };
}

/** The detail row is the full view plus the recipient count. */
export function toNotificationDetailView(row) {
  return {
    ...toNotificationView(row),
    recipientCount: embeddedCount(row.notification_recipients),
  };
}

/** The compose pickers: role and branch options. */
export function toAudienceOptionsView({ roles, branches }) {
  return {
    roles: roles.map((role) => ({ id: role.id, key: role.key, name: role.name })),
    branches: branches.map((branch) => ({ id: branch.id, name: branch.name })),
  };
}
