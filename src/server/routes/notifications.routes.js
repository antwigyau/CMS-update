/**
 * Notification endpoints — the inbox everyone reads, and the publisher console.
 *
 *   GET    /api/notifications                    the caller's inbox
 *   GET    /api/notifications/unread-count        the unread badge count
 *   POST   /api/notifications/read-all            mark the whole inbox read
 *   POST   /api/notifications/:id/read            mark one read
 *   GET    /api/admin/notifications               everything published (paginated)
 *   GET    /api/admin/notifications/audiences     the compose pickers
 *   POST   /api/admin/notifications               publish a notification
 *   GET    /api/admin/notifications/:id           one published notification
 *   DELETE /api/admin/notifications/:id           retract a notification
 *
 * Two global permissions gate the surface: `notifications.view` (held by nearly
 * every role) for the inbox, and `notifications.create` (senior pastor and
 * secretary) for publishing. Both are seeded with a null branch, so the unscoped
 * `context.can(...)` is the right question and every route is gated directly.
 *
 * **Every guard here is a mirror.** RLS on `notifications` and
 * `notification_recipients` is the real authority: the inbox only ever shows a
 * user rows addressed to them, a read-marking is scoped to the caller, and
 * publishing (both the notification and its delivery rows) is gated on
 * `notifications.create`. Reads and read-markings are not audited — they are
 * per-user and high-volume; only publishing and retraction are.
 */

import { created, noContent, ok } from '../../lib/http.js';
import { buildPageMeta, readPagination } from '../../lib/pagination.js';
import { validate } from '../../validation/index.js';
import {
  notificationCreateSchema,
  toAudienceOptionsView,
  toInboxView,
  toNotificationDetailView,
  toPublishedListView,
  toNotificationRow,
} from '../../validation/notifications.schemas.js';

export function registerNotificationsRoutes(router, { notifications, audit }) {
  /* ---- inbox ------------------------------------------------------------ */

  async function inbox(context) {
    const rows = await notifications.listInbox({
      accessToken: context.session.accessToken,
      userId: context.session.userId,
    });
    return ok(rows.map(toInboxView));
  }

  async function unreadCount(context) {
    const count = await notifications.unreadCount({
      accessToken: context.session.accessToken,
      userId: context.session.userId,
    });
    return ok({ count });
  }

  async function markAllRead(context) {
    await notifications.markAllRead({
      accessToken: context.session.accessToken,
      userId: context.session.userId,
    });
    return noContent();
  }

  async function markRead(context) {
    await notifications.markRead({
      accessToken: context.session.accessToken,
      userId: context.session.userId,
      id: context.params.id,
    });
    return noContent();
  }

  /* ---- publisher list / pickers ----------------------------------------- */

  async function listPublished(context) {
    const pagination = readPagination(context.query);
    const { rows, total } = await notifications.listPublished({
      accessToken: context.session.accessToken,
      pagination,
    });

    return ok(
      rows.map(toPublishedListView),
      buildPageMeta({ page: pagination.page, pageSize: pagination.pageSize, total }),
    );
  }

  async function audiences(context) {
    const options = await notifications.listAudienceOptions({
      accessToken: context.session.accessToken,
    });
    return ok(toAudienceOptionsView(options));
  }

  /* ---- publish ---------------------------------------------------------- */

  async function publish(context) {
    const input = validate(notificationCreateSchema, await context.json());
    const accessToken = context.session.accessToken;

    const row = await notifications.create({
      accessToken,
      row: { ...toNotificationRow(input), created_by: context.session.userId },
    });

    // Fan out delivery rows. A role or branch that matches nobody still leaves a
    // published notification (recipientCount 0) — the publisher can see it via
    // `notifications_select`.
    const userIds = await notifications.resolveAudience({
      accessToken,
      audience: input.audience,
      roleId: input.audienceRoleId,
      branchId: input.branchId,
    });
    await notifications.addRecipients({ accessToken, notificationId: row.id, userIds });

    await audit.record(context, {
      action: 'notification.published',
      resourceType: 'notification',
      resourceId: row.id,
      branchId: row.branch_id ?? null,
      changes: {
        type: input.type,
        severity: input.severity,
        audience: input.audience,
        recipientCount: userIds.length,
      },
    });

    return created(
      { ...toNotificationDetailView(row), recipientCount: userIds.length },
      { location: `/api/admin/notifications/${row.id}` },
    );
  }

  /* ---- read / retract --------------------------------------------------- */

  async function read(context) {
    const row = await notifications.get({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });
    return ok(toNotificationDetailView(row));
  }

  async function remove(context) {
    const accessToken = context.session.accessToken;
    const id = context.params.id;

    // 404 before delete, so retracting a missing id is a clean not-found rather
    // than a silent no-op.
    const row = await notifications.get({ accessToken, id });
    await notifications.remove({ accessToken, id });

    await audit.record(context, {
      action: 'notification.deleted',
      resourceType: 'notification',
      resourceId: id,
      branchId: row.branch_id ?? null,
      changes: { type: row.type, audience: row.audience },
    });

    return noContent();
  }

  /* ---- registration ----------------------------------------------------- */

  router.get('/notifications', inbox, { permission: 'notifications.view' });
  router.get('/notifications/unread-count', unreadCount, { permission: 'notifications.view' });
  router.post('/notifications/read-all', markAllRead, { permission: 'notifications.view' });
  router.post('/notifications/:id/read', markRead, { permission: 'notifications.view' });

  router.get('/admin/notifications', listPublished, { permission: 'notifications.create' });
  // The literal must be registered before `/admin/notifications/:id`, or
  // "audiences" would be read as an id and captured by the parameter route first.
  router.get('/admin/notifications/audiences', audiences, { permission: 'notifications.create' });
  router.post('/admin/notifications', publish, { permission: 'notifications.create' });
  router.get('/admin/notifications/:id', read, { permission: 'notifications.create' });
  router.delete('/admin/notifications/:id', remove, { permission: 'notifications.create' });
}
