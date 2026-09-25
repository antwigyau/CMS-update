/**
 * Attendance data access.
 *
 * Two things shape this module.
 *
 * **Decision D5.** A session carries named records and aggregate headcounts side
 * by side. The list query fetches both — the generated `count_total` and an
 * embedded `count` of the named records — so a report can say "212 present, 148
 * identified" without a second request per session.
 *
 * **Closing freezes the register.** A database trigger refuses any write to
 * `attendance_records` whose session is closed, and reopening requires
 * `attendance.session.close` regardless of ministry leadership. Nothing in this
 * module needs to check that; it is stated here so the behaviour is not a surprise
 * when a write returns 409.
 */

import { createUserClient } from '../data/supabase-user.js';
import { unwrap } from '../data/errors.js';
import { notFound } from '../lib/errors.js';

const LIST_COLUMNS = `
  id, session_type, title, session_date, status, ministry_id, count_total,
  ministries ( name ), attendance_records(count)
`
  .replace(/\s+/g, ' ')
  .trim();

const DETAIL_COLUMNS = `
  id, branch_id, session_type, title, session_date, start_time, end_time,
  ministry_id, event_id, status,
  count_adults, count_youth, count_children, count_visitors, count_total,
  notes, closed_at, created_at, updated_at,
  ministries ( name ), events ( title )
`
  .replace(/\s+/g, ' ')
  .trim();

const RECORD_COLUMNS = `
  id, member_id, guest_name, status, method, check_in_at, notes,
  members ( member_no, full_name, membership_status, photo_path )
`
  .replace(/\s+/g, ' ')
  .trim();

const HISTORY_COLUMNS = `
  id, session_id, status, check_in_at,
  attendance_sessions ( title, session_date, session_type )
`
  .replace(/\s+/g, ' ')
  .trim();

export function createAttendanceService({ getClient = createUserClient } = {}) {
  async function listSessions({
    accessToken,
    branchId,
    sessionType,
    status,
    ministryId,
    from,
    to,
    sort,
    pagination,
  }) {
    let query = getClient(accessToken)
      .from('attendance_sessions')
      .select(LIST_COLUMNS, { count: 'exact' });

    if (branchId) query = query.eq('branch_id', branchId);
    if (sessionType) query = query.eq('session_type', sessionType);
    if (status) query = query.eq('status', status);
    if (ministryId) query = query.eq('ministry_id', ministryId);
    // A date window rather than a single date: "last month's attendance" is the
    // question people actually ask.
    if (from) query = query.gte('session_date', from);
    if (to) query = query.lte('session_date', to);

    query = query
      .order(sort.column, { ascending: sort.ascending })
      .order('id', { ascending: true })
      .range(pagination.from, pagination.to);

    const result = await query;
    const rows = unwrap(result, { resource: 'attendance session' });

    return { rows: rows ?? [], total: result.count ?? null };
  }

  async function getSession({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('attendance_sessions')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    const row = unwrap(result, { resource: 'attendance session' });
    if (!row) throw notFound('That attendance session does not exist.');
    return row;
  }

  async function createSession({ accessToken, row }) {
    const result = await getClient(accessToken)
      .from('attendance_sessions')
      .insert(row)
      .select(DETAIL_COLUMNS)
      .single();

    return unwrap(result, { resource: 'attendance session' });
  }

  async function updateSession({ accessToken, id, patch }) {
    const result = await getClient(accessToken)
      .from('attendance_sessions')
      .update(patch)
      .eq('id', id)
      .select(DETAIL_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'attendance session' });
    if (!row) throw notFound('That attendance session does not exist.');
    return row;
  }

  async function removeSession({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('attendance_sessions')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();

    const row = unwrap(result, { resource: 'attendance session' });
    if (!row) throw notFound('That attendance session does not exist.');
    return row;
  }

  async function listRecords({ accessToken, sessionId }) {
    const result = await getClient(accessToken)
      .from('attendance_records')
      .select(RECORD_COLUMNS)
      .eq('session_id', sessionId)
      .order('check_in_at', { ascending: true });

    return unwrap(result, { resource: 'attendance record' }) ?? [];
  }

  /**
   * Write the register.
   *
   * One `insert` with an array is a single statement, so the whole batch is
   * atomic: if one member is already recorded, none of the batch is written. That
   * is the right failure for a register — a partially applied roll call is worse
   * than a rejected one, because nobody can tell which half took.
   */
  async function addRecords({ accessToken, sessionId, branchId, rows }) {
    const payload = rows.map((row) => ({
      ...row,
      session_id: sessionId,
      branch_id: branchId,
    }));

    const result = await getClient(accessToken)
      .from('attendance_records')
      .insert(payload)
      .select(RECORD_COLUMNS);

    return unwrap(result, { resource: 'attendance record' }) ?? [];
  }

  async function updateRecord({ accessToken, sessionId, recordId, patch }) {
    const result = await getClient(accessToken)
      .from('attendance_records')
      .update(patch)
      .eq('id', recordId)
      // Scoped to the session in the path, so a record id from another session
      // cannot be edited through this one.
      .eq('session_id', sessionId)
      .select(RECORD_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'attendance record' });
    if (!row) throw notFound('That attendance record does not exist.');
    return row;
  }

  async function removeRecord({ accessToken, sessionId, recordId }) {
    const result = await getClient(accessToken)
      .from('attendance_records')
      .delete()
      .eq('id', recordId)
      .eq('session_id', sessionId)
      .select('id')
      .maybeSingle();

    const row = unwrap(result, { resource: 'attendance record' });
    if (!row) throw notFound('That attendance record does not exist.');
    return row;
  }

  /** A member's own attendance history, newest first. */
  async function listForMember({ accessToken, memberId, pagination }) {
    const result = await getClient(accessToken)
      .from('attendance_records')
      .select(HISTORY_COLUMNS, { count: 'exact' })
      .eq('member_id', memberId)
      .order('check_in_at', { ascending: false })
      .range(pagination.from, pagination.to);

    const rows = unwrap(result, { resource: 'attendance record' });
    return { rows: rows ?? [], total: result.count ?? null };
  }

  return {
    listSessions,
    getSession,
    createSession,
    updateSession,
    removeSession,
    listRecords,
    addRecords,
    updateRecord,
    removeRecord,
    listForMember,
  };
}
