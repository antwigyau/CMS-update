/**
 * Notification-shaped fixtures.
 *
 * Raw snake_case rows as the query recorder hands them back, matching the columns
 * the notifications service selects. The inbox row embeds the caller's own
 * delivery row (`notification_recipients: [{ read_at, user_id }]`) the way
 * PostgREST returns an `!inner` join; the published/detail row embeds the
 * recipient-count aggregate (`notification_recipients: [{ count }]`). Both feed
 * the real view mappers, so a shape mistake surfaces here rather than in
 * production.
 */

// A published notification. Client input never sets this id — it is DB-supplied —
// so a fixed value is fine.
export const NOTIFICATION_ID = 'a7a7a7a7-7777-4777-8777-777777777777';

// Audience targets. Validated as UUIDs on the compose payload, so they must be
// well-formed or every publish test would collapse into a 422.
export const ROLE_ID = 'b8b8b8b8-8888-4888-8888-888888888888';
export const BRANCH_ID = 'c9c9c9c9-9999-4999-8999-999999999999';

/** The row echoed back after an insert/select — the full notification columns. */
export function notificationRow(overrides = {}) {
  return {
    id: NOTIFICATION_ID,
    branch_id: null,
    type: 'announcement',
    severity: 'info',
    title: 'Harvest service moved to 9am',
    body: 'The harvest service now begins at 9am. Please arrive early.',
    audience: 'all',
    audience_role_id: null,
    link_path: null,
    published_at: '2026-09-20T08:00:00.000Z',
    expires_at: null,
    created_by: 'user-20',
    created_at: '2026-09-20T08:00:00.000Z',
    updated_at: '2026-09-20T08:00:00.000Z',
    ...overrides,
  };
}
/** One inbox row: the notification joined to the caller's own delivery row. */
export function inboxRow(overrides = {}) {
  const { notification_recipients, ...rest } = overrides;
  return {
    id: NOTIFICATION_ID,
    type: 'announcement',
    severity: 'info',
    title: 'Harvest service moved to 9am',
    body: 'The harvest service now begins at 9am. Please arrive early.',
    link_path: null,
    published_at: '2026-09-20T08:00:00.000Z',
    notification_recipients: notification_recipients ?? [{ read_at: null, user_id: 'user-21' }],
    ...rest,
  };
}

/** A published-list / detail row: the notification plus its recipient count. */
export function publishedListRow(overrides = {}) {
  const { notification_recipients, ...rest } = overrides;
  return {
    ...notificationRow(rest),
    notification_recipients: notification_recipients ?? [{ count: 5 }],
  };
}

/** One role option for the compose picker: `roles.select('id, key, name')`. */
export function roleOptionRow(overrides = {}) {
  return { id: ROLE_ID, key: 'finance_officer', name: 'Finance officer', ...overrides };
}

/** One branch option for the compose picker: `branches.select('id, name')`. */
export function branchOptionRow(overrides = {}) {
  return { id: BRANCH_ID, name: 'Main campus', ...overrides };
}
