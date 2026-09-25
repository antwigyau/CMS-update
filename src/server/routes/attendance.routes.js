/**
 * Attendance endpoints.
 *
 *   GET    /api/attendance/sessions                       list, filter, paginate
 *   POST   /api/attendance/sessions                       open a session
 *   GET    /api/attendance/sessions/:id                   the session and its register
 *   PATCH  /api/attendance/sessions/:id                   edit, close, or reopen
 *   DELETE /api/attendance/sessions/:id                   delete
 *   POST   /api/attendance/sessions/:id/records           write the register (bulk)
 *   PATCH  /api/attendance/sessions/:id/records/:recordId correct one entry
 *   DELETE /api/attendance/sessions/:id/records/:recordId remove one entry
 *   GET    /api/members/:id/attendance                    one member's history
 *
 * **Leadership, again, but keyed on the session's ministry.**
 *
 * A ministry leader may run the register for their own ministry's sessions without
 * holding `attendance.record` branch-wide — the RLS policies use
 * `app.leads_session_ministry(session_id)`. At this layer the session row carries
 * `ministry_id`, so once it is read the check is a lookup in
 * `session.ledMinistryIds`: no extra round trip (ADR-042).
 *
 * **Two things leadership does NOT confer**, mirroring the database exactly:
 *
 *   * opening a SERVICE session — that is the whole congregation, not one ministry
 *   * reopening a closed session — the trigger requires
 *     `attendance.session.close` and does not accept leadership
 */

import { forbidden, validationFailed } from '../../lib/errors.js';
import { created, noContent, ok } from '../../lib/http.js';
import { buildPageMeta, readPagination, readSort } from '../../lib/pagination.js';
import { validate } from '../../validation/index.js';
import {
  SESSION_SORTS,
  SESSION_STATUSES,
  SESSION_TYPES,
  recordUpdateSchema,
  recordsCreateSchema,
  sessionCreateSchema,
  sessionUpdateSchema,
  toHistoryView,
  toRecordRow,
  toRecordView,
  toSessionListView,
  toSessionRow,
  toSessionView,
} from '../../validation/attendance.schemas.js';
import { assertPermissionIn } from '../middleware/auth.js';
import { resolveBranchId } from '../branch.js';

/** A date in the query string, ignored if it is not one. */
function readDate(query, name) {
  const value = query.get(name)?.trim();
  if (!value) return undefined;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationFailed('That date filter is not a date.', {
      details: { fields: { [name]: 'Use YYYY-MM-DD.' } },
    });
  }
  return value;
}

function readEnum(query, name, allowed) {
  const value = query.get(name)?.trim();
  if (!value) return undefined;

  if (!allowed.includes(value)) {
    throw validationFailed(`That ${name} filter is not recognised.`, {
      details: { fields: { [name]: `Use one of: ${allowed.join(', ')}.` } },
    });
  }
  return value;
}

export function registerAttendanceRoutes(router, { attendance, audit }) {
  /** Does the caller lead the ministry this session belongs to? */
  const leadsSession = (context, session) =>
    Boolean(session.ministry_id) && context.leadsMinistry(session.ministry_id);

  /**
   * Authority over one session: the branch permission, or leadership of the
   * ministry that met. The API-layer mirror of
   * `permission OR app.leads_session_ministry(session_id)`.
   */
  function assertSessionAuthority(context, permission, session) {
    if (context.can(permission, session.branch_id)) return;
    if (leadsSession(context, session)) return;

    context.logger.warn('attendance authority denied', { permission, sessionId: session.id });
    throw forbidden('You do not have permission to do that.');
  }

  /* ---- sessions: list --------------------------------------------------- */

  async function listSessions(context) {
    const pagination = readPagination(context.query);
    const sort = readSort(context.query.get('sort'), SESSION_SORTS, 'date');

    const { rows, total } = await attendance.listSessions({
      accessToken: context.session.accessToken,
      branchId: context.query.get('branchId') || undefined,
      sessionType: readEnum(context.query, 'sessionType', SESSION_TYPES),
      status: readEnum(context.query, 'status', SESSION_STATUSES),
      ministryId: context.query.get('ministryId') || undefined,
      from: readDate(context.query, 'from'),
      to: readDate(context.query, 'to'),
      // Newest first by default: the register someone wants is almost always the
      // most recent one.
      sort: sort.key === 'date' ? { ...sort, ascending: false } : sort,
      pagination,
    });

    return ok(rows.map(toSessionListView), {
      ...buildPageMeta({ page: pagination.page, pageSize: pagination.pageSize, total }),
      sort: sort.key,
    });
  }

  /* ---- sessions: create ------------------------------------------------- */

  async function createSession(context) {
    const payload = await context.json();
    const input = validate(sessionCreateSchema, {
      ...payload,
      branchId: resolveBranchId(context, payload?.branchId),
    });

    // A ministry leader may open a session for their OWN ministry. A service
    // session is the whole congregation, so it always needs the permission.
    const leadsThisMinistry =
      input.sessionType === 'ministry' && context.leadsMinistry(input.ministryId);

    if (!leadsThisMinistry) {
      assertPermissionIn(context, 'attendance.session.create', input.branchId);
    }

    const row = await attendance.createSession({
      accessToken: context.session.accessToken,
      row: toSessionRow(input),
    });

    context.logger.info('attendance session opened', {
      sessionId: row.id,
      sessionType: row.session_type,
      sessionDate: row.session_date,
    });
    await audit.record(context, {
      action: 'attendance.session_opened',
      resourceType: 'attendance_session',
      resourceId: row.id,
      branchId: row.branch_id,
      changes: { sessionType: row.session_type, sessionDate: row.session_date },
    });

    return created(toSessionView(row), { location: `/api/attendance/sessions/${row.id}` });
  }

  /* ---- sessions: read -------------------------------------------------- */

  async function readSession(context) {
    const { accessToken } = context.session;
    const session = await attendance.getSession({ accessToken, id: context.params.id });
    const records = await attendance.listRecords({ accessToken, sessionId: session.id });

    const view = records.map(toRecordView);

    return ok({
      ...toSessionView(session),
      records: view,
      // Both numbers, side by side, never reconciled (decision D5).
      namedCount: view.length,
      presentCount: view.filter((record) => record.status === 'present').length,
      youLead: leadsSession(context, session),
      // The register is frozen once the session is closed, by a database trigger.
      canRecord:
        session.status === 'open' &&
        (context.can('attendance.record', session.branch_id) || leadsSession(context, session)),
    });
  }

  /* ---- sessions: update, close, reopen ---------------------------------- */

  async function updateSession(context) {
    const input = validate(sessionUpdateSchema, await context.json());
    const { accessToken } = context.session;

    const session = await attendance.getSession({ accessToken, id: context.params.id });

    const closing = input.status === 'closed' && session.status === 'open';
    const reopening = input.status === 'open' && session.status === 'closed';

    if (reopening) {
      // Leadership does not help here, and saying so plainly is better than
      // letting the database trigger produce the refusal.
      assertPermissionIn(context, 'attendance.session.close', session.branch_id);
    } else if (closing) {
      assertSessionAuthority(context, 'attendance.session.close', session);
    } else {
      assertSessionAuthority(context, 'attendance.session.create', session);
    }

    const row = await attendance.updateSession({
      accessToken,
      id: session.id,
      patch: toSessionRow(input),
    });

    const fields = Object.keys(input).sort();
    context.logger.info('attendance session updated', {
      sessionId: row.id,
      fields,
      status: row.status,
    });
    await audit.record(context, {
      action: reopening
        ? 'attendance.session_reopened'
        : closing
          ? 'attendance.session_closed'
          : 'attendance.session_updated',
      resourceType: 'attendance_session',
      resourceId: row.id,
      branchId: row.branch_id,
      changes: { fields, status: row.status },
    });

    return ok(toSessionView(row));
  }

  async function removeSession(context) {
    const { accessToken } = context.session;
    const session = await attendance.getSession({ accessToken, id: context.params.id });

    // Deleting a register discards everyone's attendance for that gathering, so
    // leadership does not confer it.
    assertPermissionIn(context, 'attendance.delete', session.branch_id);

    await attendance.removeSession({ accessToken, id: session.id });

    context.logger.info('attendance session deleted', { sessionId: session.id });
    await audit.record(context, {
      action: 'attendance.session_deleted',
      resourceType: 'attendance_session',
      resourceId: session.id,
      branchId: session.branch_id,
    });
    return noContent();
  }

  /* ---- records ---------------------------------------------------------- */

  async function addRecords(context) {
    const inputs = validate(recordsCreateSchema, await context.json());
    const { accessToken } = context.session;

    const session = await attendance.getSession({ accessToken, id: context.params.id });
    assertSessionAuthority(context, 'attendance.record', session);

    if (session.status === 'closed') {
      // The database trigger would refuse this anyway; catching it here gives a
      // message that says what to do about it.
      throw validationFailed('This session is closed. Reopen it before changing the register.', {
        details: {
          fields: { status: 'Reopening requires the attendance.session.close permission.' },
        },
      });
    }

    const rows = await attendance.addRecords({
      accessToken,
      sessionId: session.id,
      branchId: session.branch_id,
      rows: inputs.map(toRecordRow),
    });

    context.logger.info('attendance recorded', {
      sessionId: session.id,
      count: rows.length,
    });
    await audit.record(context, {
      action: 'attendance.recorded',
      resourceType: 'attendance_session',
      resourceId: session.id,
      branchId: session.branch_id,
      changes: { count: rows.length },
    });

    return created(rows.map(toRecordView));
  }

  async function updateRecord(context) {
    const input = validate(recordUpdateSchema, await context.json());
    const { accessToken } = context.session;

    const session = await attendance.getSession({ accessToken, id: context.params.id });
    assertSessionAuthority(context, 'attendance.update', session);

    const row = await attendance.updateRecord({
      accessToken,
      sessionId: session.id,
      recordId: context.params.recordId,
      patch: {
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      },
    });

    context.logger.info('attendance record corrected', {
      sessionId: session.id,
      recordId: row.id,
    });
    await audit.record(context, {
      action: 'attendance.record_corrected',
      resourceType: 'attendance_session',
      resourceId: session.id,
      branchId: session.branch_id,
      changes: { recordId: row.id },
    });

    return ok(toRecordView(row));
  }

  async function removeRecord(context) {
    const { accessToken } = context.session;
    const session = await attendance.getSession({ accessToken, id: context.params.id });

    assertPermissionIn(context, 'attendance.delete', session.branch_id);

    await attendance.removeRecord({
      accessToken,
      sessionId: session.id,
      recordId: context.params.recordId,
    });

    context.logger.info('attendance record removed', {
      sessionId: session.id,
      recordId: context.params.recordId,
    });
    await audit.record(context, {
      action: 'attendance.record_removed',
      resourceType: 'attendance_session',
      resourceId: session.id,
      branchId: session.branch_id,
      changes: { recordId: context.params.recordId },
    });

    return noContent();
  }

  /* ---- one member's history -------------------------------------------- */

  /**
   * Registered with `attendance.view`, but a member reading their OWN history
   * holds no such permission — decision D4 gives them their profile and their
   * attendance. RLS allows `member_id = app.current_member_id()`, so for them this
   * route needs no permission at all.
   *
   * The route therefore cannot be guarded by `attendance.view`: it would refuse the
   * member the database is willing to serve. It is guarded by `members.view`
   * instead — which a member does hold for their own record — and RLS narrows the
   * rows. A caller with neither gets an empty page, not a leak.
   */
  async function memberHistory(context) {
    const pagination = readPagination(context.query, { defaultPageSize: 50 });

    const { rows, total } = await attendance.listForMember({
      accessToken: context.session.accessToken,
      memberId: context.params.id,
      pagination,
    });

    return ok(rows.map(toHistoryView), {
      ...buildPageMeta({ page: pagination.page, pageSize: pagination.pageSize, total }),
    });
  }

  /* ---- registration ----------------------------------------------------- */

  router.get('/attendance/sessions', listSessions, { permission: 'attendance.view' });
  router.post('/attendance/sessions', createSession, {
    permission: 'attendance.session.create',
    guard: 'permissionOrLeadership',
  });
  router.get('/attendance/sessions/:id', readSession, { permission: 'attendance.view' });
  router.patch('/attendance/sessions/:id', updateSession, {
    permission: 'attendance.session.create',
    guard: 'permissionOrLeadership',
  });
  router.delete('/attendance/sessions/:id', removeSession, { permission: 'attendance.delete' });

  router.post('/attendance/sessions/:id/records', addRecords, {
    permission: 'attendance.record',
    guard: 'permissionOrLeadership',
  });
  router.patch('/attendance/sessions/:id/records/:recordId', updateRecord, {
    permission: 'attendance.update',
    guard: 'permissionOrLeadership',
  });
  router.delete('/attendance/sessions/:id/records/:recordId', removeRecord, {
    permission: 'attendance.delete',
  });

  router.get('/members/:id/attendance', memberHistory, { permission: 'members.view' });
}
