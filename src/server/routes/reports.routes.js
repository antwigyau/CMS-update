/**
 * Reporting endpoints.
 *
 *   GET /api/reports/finance/summary        income, expense, net, breakdowns
 *   GET /api/reports/finance/export         the same rows as CSV
 *   GET /api/reports/members/summary        counts by status, gender, baptism
 *   GET /api/reports/members/export
 *   GET /api/reports/attendance/summary     sessions, headcount, by type
 *   GET /api/reports/attendance/export
 *   GET /api/reports/ministries/summary     active membership per ministry
 *   GET /api/reports/ministries/export
 *   GET /api/reports/events/summary         events by status, registrations
 *   GET /api/reports/events/export
 *
 * Every route is a GET guarded by the matching `reports.*` permission — there is
 * no income/expense permission split, so both sides of the ledger sit behind
 * `reports.finance.view`. Read-only by nature: nothing here writes, so there is
 * no CSRF concern and no state-changing route to gate more tightly.
 *
 * The `/export` routes return CSV under the same permission as the summary: the
 * export is the very rows the caller can already see, in a file rather than on a
 * page. The separate `finance.export` / `members.export` permissions govern
 * exporting the *operational* lists (the raw ledger, the full roll); a report a
 * role may read, it may also download (ADR-058).
 */

import { ok, fileResponse } from '../../lib/http.js';
import { validationFailed } from '../../lib/errors.js';
import { toCsv } from '../../lib/csv.js';
import {
  ATTENDANCE_CSV_COLUMNS,
  EVENTS_CSV_COLUMNS,
  FINANCE_CSV_COLUMNS,
  MEMBERS_CSV_COLUMNS,
  MINISTRIES_CSV_COLUMNS,
  summariseAttendance,
  summariseEvents,
  summariseFinance,
  summariseMembers,
  summariseMinistries,
} from '../../lib/reports.js';

const TRANSACTION_KINDS = ['income', 'expense'];
const MEMBERSHIP_STATUSES = ['visitor', 'new', 'active', 'inactive', 'transferred', 'deceased'];
const GENDERS = ['male', 'female'];
const SESSION_TYPES = ['service', 'event', 'ministry'];
const EVENT_STATUSES = ['draft', 'published', 'ongoing', 'completed', 'cancelled'];

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

function readDate(query, name) {
  const value = query.get(name)?.trim();
  if (!value) return undefined;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationFailed('That date filter is not a date.', {
      details: { fields: { [name]: 'Use an ISO date, for example 2026-09-01.' } },
    });
  }
  return value;
}

/** A dated, unambiguous download name, e.g. `finance-report-2026-09-21.csv`. */
function csvName(prefix) {
  return `${prefix}-report-${new Date().toISOString().slice(0, 10)}.csv`;
}

function csv(rows, columns, prefix) {
  return fileResponse(toCsv(rows, columns), {
    contentType: 'text/csv; charset=utf-8',
    filename: csvName(prefix),
  });
}

export function registerReportRoutes(router, { reports }) {
  /* ---- finance ---------------------------------------------------------- */

  function financeArgs(context) {
    return {
      accessToken: context.session.accessToken,
      branchId: context.query.get('branchId') || undefined,
      kind: readEnum(context.query, 'kind', TRANSACTION_KINDS),
      from: readDate(context.query, 'from'),
      to: readDate(context.query, 'to'),
    };
  }

  async function financeSummary(context) {
    const { rows } = await reports.fetchFinance(financeArgs(context));
    return ok(summariseFinance(rows));
  }

  async function financeExport(context) {
    const { rows } = await reports.fetchFinance(financeArgs(context));
    return csv(rows, FINANCE_CSV_COLUMNS, 'finance');
  }

  /* ---- members ---------------------------------------------------------- */

  function memberArgs(context) {
    return {
      accessToken: context.session.accessToken,
      branchId: context.query.get('branchId') || undefined,
      status: readEnum(context.query, 'status', MEMBERSHIP_STATUSES),
      gender: readEnum(context.query, 'gender', GENDERS),
      joinedFrom: readDate(context.query, 'joinedFrom'),
      joinedTo: readDate(context.query, 'joinedTo'),
    };
  }

  async function membersSummary(context) {
    const { rows } = await reports.fetchMembers(memberArgs(context));
    return ok(summariseMembers(rows));
  }

  async function membersExport(context) {
    const { rows } = await reports.fetchMembers(memberArgs(context));
    return csv(rows, MEMBERS_CSV_COLUMNS, 'members');
  }

  /* ---- attendance ------------------------------------------------------- */

  function attendanceArgs(context) {
    return {
      accessToken: context.session.accessToken,
      branchId: context.query.get('branchId') || undefined,
      sessionType: readEnum(context.query, 'sessionType', SESSION_TYPES),
      from: readDate(context.query, 'from'),
      to: readDate(context.query, 'to'),
    };
  }

  async function attendanceSummary(context) {
    const { rows } = await reports.fetchAttendance(attendanceArgs(context));
    return ok(summariseAttendance(rows));
  }

  async function attendanceExport(context) {
    const { rows } = await reports.fetchAttendance(attendanceArgs(context));
    return csv(rows, ATTENDANCE_CSV_COLUMNS, 'attendance');
  }

  /* ---- ministries ------------------------------------------------------- */

  function ministryArgs(context) {
    return {
      accessToken: context.session.accessToken,
      branchId: context.query.get('branchId') || undefined,
    };
  }

  async function ministriesSummary(context) {
    const { rows } = await reports.fetchMinistries(ministryArgs(context));
    return ok(summariseMinistries(rows));
  }

  async function ministriesExport(context) {
    const { rows } = await reports.fetchMinistries(ministryArgs(context));
    return csv(rows, MINISTRIES_CSV_COLUMNS, 'ministries');
  }

  /* ---- events ----------------------------------------------------------- */

  function eventArgs(context) {
    return {
      accessToken: context.session.accessToken,
      branchId: context.query.get('branchId') || undefined,
      status: readEnum(context.query, 'status', EVENT_STATUSES),
      from: readDate(context.query, 'from'),
      to: readDate(context.query, 'to'),
    };
  }

  async function eventsSummary(context) {
    const { rows } = await reports.fetchEvents(eventArgs(context));
    return ok(summariseEvents(rows));
  }

  async function eventsExport(context) {
    const { rows } = await reports.fetchEvents(eventArgs(context));
    return csv(rows, EVENTS_CSV_COLUMNS, 'events');
  }

  /* ---- registration ----------------------------------------------------- */

  router.get('/reports/finance/summary', financeSummary, { permission: 'reports.finance.view' });
  router.get('/reports/finance/export', financeExport, { permission: 'reports.finance.view' });
  router.get('/reports/members/summary', membersSummary, { permission: 'reports.members.view' });
  router.get('/reports/members/export', membersExport, { permission: 'reports.members.view' });
  router.get('/reports/attendance/summary', attendanceSummary, {
    permission: 'reports.attendance.view',
  });
  router.get('/reports/attendance/export', attendanceExport, {
    permission: 'reports.attendance.view',
  });
  router.get('/reports/ministries/summary', ministriesSummary, {
    permission: 'reports.ministry.view',
  });
  router.get('/reports/ministries/export', ministriesExport, {
    permission: 'reports.ministry.view',
  });
  router.get('/reports/events/summary', eventsSummary, { permission: 'reports.event.view' });
  router.get('/reports/events/export', eventsExport, { permission: 'reports.event.view' });
}
