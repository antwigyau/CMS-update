/**
 * Notification data access — the inbox, the unread badge, and publishing.
 *
 * The USER client only (RLS applies). The database is the real authority:
 * `notifications_select` shows a user a notification only through a
 * `notification_recipients` row (or `notifications.create` for a publisher);
 * `notifications_write` and `notification_recipients_insert` gate publishing on
 * `notifications.create`; and `notification_recipients_update_own` scopes a
 * read-marking to the caller. This module only shapes the queries — it never
 * bypasses RLS, so there is no admin/service-role client here.
 *
 * Recipient fan-out is resolved API-side under the same user client: both
 * publishers hold `users.view`, and `profiles_select_managed` /
 * `user_roles_select_managed` grant the reads used here, so no SECURITY DEFINER
 * function is needed.
 *
 * Methods return raw snake_case rows; mapping to the camelCase view shapes is the
 * routes layer's job (`notifications.schemas.js`).
 */

import { createUserClient } from '../data/supabase-user.js';
import { unwrap } from '../data/errors.js';
import { notFound } from '../lib/errors.js';

// The inbox row: the notification, joined to the caller's own delivery row so its
// read state comes back with it. `!inner` drops notifications the caller was not
// addressed to, even for a publisher who could otherwise see them all.
const INBOX_COLUMNS =
  'id, type, severity, title, body, link_path, published_at, notification_recipients!inner(read_at, user_id)';

// The full notification, for the publisher's list and detail views.
const NOTIFICATION_COLUMNS =
  'id, branch_id, type, severity, title, body, audience, audience_role_id, link_path, published_at, expires_at, created_by, created_at, updated_at';

// The detail/list row also carries how many recipients it reached.
const DETAIL_COLUMNS = `${NOTIFICATION_COLUMNS}, notification_recipients(count)`;

export function createNotificationsService({ getClient = createUserClient } = {}) {
  /* ---- inbox (everyone) ------------------------------------------------- */

  /** The caller's own inbox: live notifications addressed to them, newest first. */
  async function listInbox({ accessToken, userId }) {
    const nowIso = new Date().toISOString();
    const result = await getClient(accessToken)
      .from('notifications')
      .select(INBOX_COLUMNS)
      .eq('notification_recipients.user_id', userId)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order('published_at', { ascending: false });

    return unwrap(result, { resource: 'notification' }) ?? [];
  }

  /** How many of the caller's notifications are unread — drives the bell badge. */
  async function unreadCount({ accessToken, userId }) {
    const result = await getClient(accessToken)
      .from('notification_recipients')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('read_at', null);

    unwrap(result, { resource: 'notification' });
    return result.count ?? 0;
  }

  /** Mark one notification read for the caller. RLS scopes the update to self; a
   * wrong id simply matches no row. */
  async function markRead({ accessToken, userId, id }) {
    const result = await getClient(accessToken)
      .from('notification_recipients')
      .update({ read_at: new Date().toISOString() })
      .eq('notification_id', id)
      .eq('user_id', userId);

    unwrap(result, { resource: 'notification' });
  }

  /** Mark every unread notification read for the caller. */
  async function markAllRead({ accessToken, userId }) {
    const result = await getClient(accessToken)
      .from('notification_recipients')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('read_at', null);

    unwrap(result, { resource: 'notification' });
  }

  /* ---- publishing (notifications.create) -------------------------------- */

  /** Everything published, newest first, paginated with a total. */
  async function listPublished({ accessToken, pagination }) {
    const result = await getClient(accessToken)
      .from('notifications')
      .select(DETAIL_COLUMNS, { count: 'exact' })
      .order('published_at', { ascending: false })
      .range(pagination.from, pagination.to);

    const rows = unwrap(result, { resource: 'notification' }) ?? [];
    return { rows, total: result.count ?? 0 };
  }

  async function get({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('notifications')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    const row = unwrap(result, { resource: 'notification' });
    if (!row) throw notFound('That notification does not exist.');
    return row;
  }

  async function create({ accessToken, row }) {
    const result = await getClient(accessToken)
      .from('notifications')
      .insert(row)
      .select(NOTIFICATION_COLUMNS)
      .single();

    return unwrap(result, { resource: 'notification' });
  }

  /**
   * Resolve an audience to a deduped list of user ids. `all` and `branch` read
   * active profiles; `role` reads the grant table (a user may hold the role in
   * more than one branch, hence the dedupe).
   */
  async function resolveAudience({ accessToken, audience, branchId, roleId }) {
    const db = getClient(accessToken);

    if (audience === 'role') {
      const result = await db.from('user_roles').select('user_id').eq('role_id', roleId);
      const rows = unwrap(result, { resource: 'notification' }) ?? [];
      return [...new Set(rows.map((entry) => entry.user_id))];
    }

    let query = db.from('profiles').select('id').eq('is_active', true);
    if (audience === 'branch') query = query.eq('default_branch_id', branchId);
    const result = await query;
    const rows = unwrap(result, { resource: 'notification' }) ?? [];
    return [...new Set(rows.map((entry) => entry.id))];
  }

  /** Create the delivery rows. A no-op when the audience matched nobody. */
  async function addRecipients({ accessToken, notificationId, userIds }) {
    if (userIds.length === 0) return;

    const result = await getClient(accessToken)
      .from('notification_recipients')
      .insert(userIds.map((userId) => ({ notification_id: notificationId, user_id: userId })));

    unwrap(result, { resource: 'notification' });
  }

  /** The role and branch options for the compose pickers. */
  async function listAudienceOptions({ accessToken }) {
    const db = getClient(accessToken);

    const rolesResult = await db
      .from('roles')
      .select('id, key, name')
      .order('sort_order', { ascending: true });
    const branchesResult = await db.from('branches').select('id, name').order('name', {
      ascending: true,
    });

    return {
      roles: unwrap(rolesResult, { resource: 'role' }) ?? [],
      branches: unwrap(branchesResult, { resource: 'branch' }) ?? [],
    };
  }

  /** Delete a notification. Its `notification_recipients` cascade. */
  async function remove({ accessToken, id }) {
    const result = await getClient(accessToken).from('notifications').delete().eq('id', id);
    unwrap(result, { resource: 'notification' });
  }

  return {
    listInbox,
    unreadCount,
    markRead,
    markAllRead,
    listPublished,
    get,
    create,
    resolveAudience,
    addRecipients,
    listAudienceOptions,
    remove,
  };
}
