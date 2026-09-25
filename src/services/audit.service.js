/**
 * The audit trail.
 *
 * Writing is **best-effort and never fails the operation it records.** A member
 * edit that succeeded must not be rolled back because the audit write hit a
 * transient error — the edit already happened, and the database's own constraints
 * and RLS protected its integrity. A failed audit write is logged as a warning so
 * operations can notice, but `record()` never throws (ADR-059).
 *
 * The row is written by the `app.log_audit` SECURITY DEFINER function, which takes
 * the actor from the JWT, not from us — a client cannot forge who did a thing.
 * Reading is a normal RLS-scoped select behind `audit.view`.
 */

import { createUserClient } from '../data/supabase-user.js';
import { unwrap } from '../data/errors.js';

const LIST_COLUMNS =
  'id, occurred_at, actor_email, actor_name, action, resource_type, resource_id, branch_id, changes, ip, request_id';

export function createAuditService({ getClient = createUserClient } = {}) {
  /**
   * Write one audit row from a request context. Best-effort.
   *
   * @param {object} context  The request context (session, ip, requestId, logger).
   * @param {object} entry
   * @param {string} entry.action        Dotted past tense, e.g. 'member.updated'.
   * @param {string} entry.resourceType  e.g. 'member'.
   * @param {string} [entry.resourceId]
   * @param {object} [entry.changes]     Field-level diff or context — never values
   *                                     that are personal data; field names suffice.
   * @param {string} [entry.branchId]
   */
  async function record(
    context,
    { action, resourceType, resourceId = null, changes = null, branchId = null },
  ) {
    try {
      const client = getClient(context.session.accessToken);
      const { error } = await client.rpc('log_audit', {
        p_action: action,
        p_resource_type: resourceType,
        p_resource_id: resourceId === null || resourceId === undefined ? null : String(resourceId),
        p_changes: changes,
        p_branch_id: branchId ?? null,
        p_ip: context.ip ?? null,
        p_user_agent: context.request?.headers?.get('user-agent') ?? null,
        p_request_id: context.requestId ?? null,
      });

      if (error) context.logger?.warn('audit write failed', { action, code: error.code });
    } catch (cause) {
      // Never let an audit failure surface to the caller: the recorded action
      // already succeeded. Log it and move on.
      context.logger?.warn('audit write failed', {
        action,
        cause: String(cause?.message ?? cause),
      });
    }
  }

  async function list({ accessToken, action, resourceType, from, to, pagination }) {
    let query = getClient(accessToken).from('audit_logs').select(LIST_COLUMNS, { count: 'exact' });

    if (action) query = query.eq('action', action);
    if (resourceType) query = query.eq('resource_type', resourceType);
    if (from) query = query.gte('occurred_at', from);
    if (to) query = query.lte('occurred_at', to);

    query = query.order('occurred_at', { ascending: false }).range(pagination.from, pagination.to);

    const result = await query;
    const rows = unwrap(result, { resource: 'audit log' });
    return { rows: rows ?? [], total: result.count ?? null };
  }

  return { record, list };
}
