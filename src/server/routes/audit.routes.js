/**
 * The audit log viewer.
 *
 *   GET /api/admin/audit   read the trail, filtered and paginated
 *
 * Read-only: there is no write endpoint, because the only way a row enters the
 * log is `app.log_audit`, called from within the mutation it records. There is no
 * delete endpoint either — the table has no UPDATE or DELETE policy and triggers
 * that refuse both for every role, so the log is append-only in the strongest
 * sense the database offers.
 */

import { ok } from '../../lib/http.js';
import { validationFailed } from '../../lib/errors.js';
import { buildPageMeta, readPagination } from '../../lib/pagination.js';

function readTimestamp(query, name) {
  const value = query.get(name)?.trim();
  if (!value) return undefined;

  // Accept a plain date or a full ISO timestamp; anything else is a bad link.
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value)) {
    throw validationFailed('That date filter is not a date.', {
      details: { fields: { [name]: 'Use an ISO date, for example 2026-09-01.' } },
    });
  }
  return value;
}

function toAuditView(row) {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorEmail: row.actor_email,
    actorName: row.actor_name,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    branchId: row.branch_id,
    changes: row.changes,
    ip: row.ip,
    requestId: row.request_id,
  };
}

export function registerAuditRoutes(router, { audit }) {
  async function list(context) {
    const pagination = readPagination(context.query);

    const { rows, total } = await audit.list({
      accessToken: context.session.accessToken,
      action: context.query.get('action')?.trim() || undefined,
      resourceType: context.query.get('resourceType')?.trim() || undefined,
      from: readTimestamp(context.query, 'from'),
      to: readTimestamp(context.query, 'to'),
      pagination,
    });

    return ok(
      rows.map(toAuditView),
      buildPageMeta({ page: pagination.page, pageSize: pagination.pageSize, total }),
    );
  }

  router.get('/admin/audit', list, { permission: 'audit.view' });
}
