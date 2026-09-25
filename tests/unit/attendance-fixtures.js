/**
 * Attendance-shaped fixtures.
 */

import { BRANCH_MAIN, MINISTRY_CHOIR } from './auth-fixtures.js';

export const SESSION_ID = '88888888-8888-4888-8888-888888888888';
export const RECORD_ID = '99999999-9999-4999-8999-999999999999';
export const MEMBER_ID = '11111111-1111-4111-8111-111111111111';
export const EVENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export function sessionRow(overrides = {}) {
  const { ministries, events, ...rest } = overrides;
  return {
    id: SESSION_ID,
    branch_id: BRANCH_MAIN,
    session_type: 'service',
    title: 'First Service',
    session_date: '2026-08-30',
    start_time: '08:00:00',
    end_time: '10:30:00',
    ministry_id: null,
    event_id: null,
    status: 'open',
    count_adults: 120,
    count_youth: 40,
    count_children: 45,
    count_visitors: 7,
    count_total: 212,
    notes: null,
    closed_at: null,
    created_at: '2026-08-30T07:00:00.000Z',
    updated_at: '2026-08-30T07:00:00.000Z',
    ministries: ministries ?? null,
    events: events ?? null,
    ...rest,
  };
}

/** A session for the choir, which 'user-6' leads. */
export function ministrySessionRow(overrides = {}) {
  return sessionRow({
    session_type: 'ministry',
    title: 'Choir Rehearsal',
    ministry_id: MINISTRY_CHOIR,
    ministries: { name: 'Choir' },
    count_adults: 18,
    count_youth: 0,
    count_children: 0,
    count_visitors: 0,
    count_total: 18,
    ...overrides,
  });
}

export function sessionListRow(overrides = {}) {
  return {
    id: SESSION_ID,
    session_type: 'service',
    title: 'First Service',
    session_date: '2026-08-30',
    status: 'open',
    ministry_id: null,
    count_total: 212,
    ministries: null,
    attendance_records: [{ count: 148 }],
    ...overrides,
  };
}

export function recordRow(overrides = {}) {
  const { members, ...rest } = overrides;

  // An explicit `members: null` means a guest row — PostgREST returns null for an
  // embedded row that does not exist. Spreading null would silently keep the
  // defaults and make a guest look like a member.
  const embedded =
    members === null
      ? null
      : {
          member_no: 'MAIN-000101',
          full_name: 'Grace Mensah',
          membership_status: 'active',
          photo_path: null,
          ...members,
        };

  return {
    id: RECORD_ID,
    member_id: MEMBER_ID,
    guest_name: null,
    status: 'present',
    method: 'search',
    check_in_at: '2026-08-30T08:05:00.000Z',
    notes: null,
    members: embedded,
    ...rest,
  };
}

export function guestRecordRow(overrides = {}) {
  return recordRow({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    member_id: null,
    guest_name: 'Visiting Friend',
    members: null,
    ...overrides,
  });
}

export function historyRow(overrides = {}) {
  return {
    id: RECORD_ID,
    session_id: SESSION_ID,
    status: 'present',
    check_in_at: '2026-08-30T08:05:00.000Z',
    attendance_sessions: {
      title: 'First Service',
      session_date: '2026-08-30',
      session_type: 'service',
    },
    ...overrides,
  };
}

export function sessionPayload(overrides = {}) {
  return {
    sessionType: 'service',
    title: 'Second Service',
    sessionDate: new Date().toISOString().slice(0, 10),
    ...overrides,
  };
}
