/**
 * Report data access.
 *
 * One rule shapes every function here and is the phase's definition of done: a
 * report never loads an unbounded set. Each read is capped at `REPORT_ROW_CAP`
 * and asks PostgREST for the exact count, so if a filter matches more than the
 * cap the request is refused with a clear "narrow it down" rather than silently
 * truncated (which would make a total wrong) or streamed in full (which would put
 * the function's memory and the 60-second ceiling at the mercy of the data).
 *
 * Every read goes through the caller's own client, so Row Level Security scopes
 * the rows to the branches they may see. A report is therefore incapable of
 * showing a figure the caller could not reach one row at a time — the aggregate
 * inherits the same boundary as the detail.
 */

import { createUserClient } from '../data/supabase-user.js';
import { unwrap } from '../data/errors.js';
import { conflict } from '../lib/errors.js';

/**
 * The most rows any single report will load. Comfortably above a congregation's
 * yearly volume for every report here, and small enough that the reduction and
 * the CSV both fit well inside the function's limits. When a window genuinely
 * holds more, the honest answer is to ask for a narrower one.
 */
export const REPORT_ROW_CAP = 5000;

function assertWithinCap(count, { resource }) {
  if (typeof count === 'number' && count > REPORT_ROW_CAP) {
    throw conflict(
      `This ${resource} report covers ${count.toLocaleString()} rows, more than a single report can load at once. Narrow the date range or filters and try again.`,
    );
  }
}

const FINANCE_COLUMNS = `
  id, kind, income_type, amount, currency, occurred_on, payment_method, reference,
  category_id, transaction_categories ( name ), members ( full_name )
`
  .replace(/\s+/g, ' ')
  .trim();

const MEMBER_COLUMNS = `
  id, member_no, full_name, membership_status, gender, is_baptized, date_joined, phone, email
`
  .replace(/\s+/g, ' ')
  .trim();

const ATTENDANCE_COLUMNS = `
  id, session_date, title, session_type, status, count_total
`
  .replace(/\s+/g, ' ')
  .trim();

const MINISTRY_COLUMNS = `
  ministry_id, role_in_ministry, joined_on, ministries ( name ), members ( full_name )
`
  .replace(/\s+/g, ' ')
  .trim();

const EVENT_COLUMNS = `
  id, title, starts_at, status, capacity, event_registrations ( count )
`
  .replace(/\s+/g, ' ')
  .trim();

export function createReportsService({ getClient = createUserClient } = {}) {
  /**
   * Read a capped, filtered, counted page and refuse an over-large window.
   * Every fetch below is this one shape; only the table, columns, and filters
   * differ.
   */
  async function readCapped({ accessToken, table, columns, resource, apply, order }) {
    let query = getClient(accessToken).from(table).select(columns, { count: 'exact' });
    if (apply) query = apply(query);
    query = query.order(order.column, { ascending: order.ascending }).range(0, REPORT_ROW_CAP - 1);

    const result = await query;
    const rows = unwrap(result, { resource }) ?? [];
    assertWithinCap(result.count, { resource });

    return { rows, count: result.count ?? rows.length };
  }

  function fetchFinance({ accessToken, branchId, kind, from, to }) {
    return readCapped({
      accessToken,
      table: 'transactions',
      columns: FINANCE_COLUMNS,
      resource: 'finance',
      order: { column: 'occurred_on', ascending: false },
      apply: (query) => {
        query = query.eq('status', 'approved');
        if (branchId) query = query.eq('branch_id', branchId);
        if (kind) query = query.eq('kind', kind);
        if (from) query = query.gte('occurred_on', from);
        if (to) query = query.lte('occurred_on', to);
        return query;
      },
    });
  }

  function fetchMembers({ accessToken, branchId, status, gender, joinedFrom, joinedTo }) {
    return readCapped({
      accessToken,
      table: 'members',
      columns: MEMBER_COLUMNS,
      resource: 'member',
      order: { column: 'full_name', ascending: true },
      apply: (query) => {
        query = query.is('deleted_at', null);
        if (branchId) query = query.eq('branch_id', branchId);
        if (status) query = query.eq('membership_status', status);
        if (gender) query = query.eq('gender', gender);
        if (joinedFrom) query = query.gte('date_joined', joinedFrom);
        if (joinedTo) query = query.lte('date_joined', joinedTo);
        return query;
      },
    });
  }

  function fetchAttendance({ accessToken, branchId, sessionType, from, to }) {
    return readCapped({
      accessToken,
      table: 'attendance_sessions',
      columns: ATTENDANCE_COLUMNS,
      resource: 'attendance',
      order: { column: 'session_date', ascending: false },
      apply: (query) => {
        if (branchId) query = query.eq('branch_id', branchId);
        if (sessionType) query = query.eq('session_type', sessionType);
        if (from) query = query.gte('session_date', from);
        if (to) query = query.lte('session_date', to);
        return query;
      },
    });
  }

  function fetchMinistries({ accessToken, branchId }) {
    return readCapped({
      accessToken,
      table: 'ministry_members',
      columns: MINISTRY_COLUMNS,
      resource: 'ministry',
      order: { column: 'ministry_id', ascending: true },
      apply: (query) => {
        // Active memberships only — a report of who is currently serving.
        query = query.is('left_on', null);
        if (branchId) query = query.eq('branch_id', branchId);
        return query;
      },
    });
  }

  function fetchEvents({ accessToken, branchId, status, from, to }) {
    return readCapped({
      accessToken,
      table: 'events',
      columns: EVENT_COLUMNS,
      resource: 'event',
      order: { column: 'starts_at', ascending: false },
      apply: (query) => {
        if (branchId) query = query.eq('branch_id', branchId);
        if (status) query = query.eq('status', status);
        if (from) query = query.gte('starts_at', from);
        if (to) query = query.lte('starts_at', to);
        return query;
      },
    });
  }

  return { fetchFinance, fetchMembers, fetchAttendance, fetchMinistries, fetchEvents };
}
