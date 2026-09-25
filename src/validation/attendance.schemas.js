/**
 * Attendance payload validation.
 *
 * Decision D5 is visible here: a session carries BOTH named records and
 * aggregate headcounts, and the two are never reconciled. An usher counts 212
 * people and identifies 148 of them; both numbers are true, and forcing them to
 * agree would mean rejecting honest data entry.
 *
 * The session type and its reference are validated together, mirroring the
 * `attendance_sessions_type_reference` CHECK constraint: a service names neither a
 * ministry nor an event, a ministry session must name a ministry, an event session
 * must name an event.
 */

import { z } from 'zod';

export const SESSION_TYPES = ['service', 'event', 'ministry'];
export const SESSION_STATUSES = ['open', 'closed'];
export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'excused'];
/** 'qr' exists in the database enum; no scanner ships in the MVP. */
export const ATTENDANCE_METHODS = ['manual', 'search', 'qr'];

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max, `Keep this to ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullish();

const isoDate = (label) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `Enter ${label} as YYYY-MM-DD.`)
    .refine((value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
    }, 'That is not a real date.');

const optionalTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Enter a time as HH:MM, for example 09:00.')
  .transform((value) => (value === '' ? null : value.slice(0, 5)))
  .nullish();

/** A headcount. Non-negative, and capped well above any plausible congregation. */
const headcount = z.coerce
  .number()
  .int('Enter a whole number.')
  .min(0, 'A headcount cannot be negative.')
  .max(1_000_000, 'That number is implausibly large.');

const sessionFields = {
  branchId: z.string().uuid('Choose a branch.'),
  sessionType: z.enum(SESSION_TYPES, { message: 'Choose what kind of gathering this is.' }),
  title: z
    .string()
    .trim()
    .min(2, 'Give this session a title, for example "First Service".')
    .max(160, 'That title is too long.'),
  sessionDate: isoDate('the date'),
  startTime: optionalTime,
  endTime: optionalTime,
  ministryId: z.string().uuid('Choose a ministry.').nullish(),
  eventId: z.string().uuid('Choose an event.').nullish(),
  countAdults: headcount,
  countYouth: headcount,
  countChildren: headcount,
  countVisitors: headcount,
  notes: optionalText(2000),
};

/**
 * Rules that span fields. Each mirrors a CHECK constraint; the database is what
 * cannot be bypassed, these say which field to fix.
 */
function applySessionRules(schema) {
  return schema
    .refine((value) => value.sessionType !== 'service' || (!value.ministryId && !value.eventId), {
      message: 'A service session is not tied to a ministry or an event.',
      path: ['sessionType'],
    })
    .refine((value) => value.sessionType !== 'ministry' || Boolean(value.ministryId), {
      message: 'Choose which ministry met.',
      path: ['ministryId'],
    })
    .refine((value) => value.sessionType !== 'event' || Boolean(value.eventId), {
      message: 'Choose which event this was.',
      path: ['eventId'],
    })
    .refine((value) => !value.startTime || !value.endTime || value.endTime >= value.startTime, {
      message: 'The end time cannot be before the start time.',
      path: ['endTime'],
    })
    .refine(
      (value) => {
        if (!value.sessionDate) return true;
        // The database allows tomorrow, so a session can be opened the evening
        // before. Anything beyond that is a typo.
        const limit = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
        return value.sessionDate <= limit;
      },
      { message: 'A session cannot be dated more than a day ahead.', path: ['sessionDate'] },
    );
}

export const sessionCreateSchema = applySessionRules(
  z
    .object({
      ...sessionFields,
      countAdults: headcount.default(0),
      countYouth: headcount.default(0),
      countChildren: headcount.default(0),
      countVisitors: headcount.default(0),
    })
    .strict(),
);

/**
 * Update.
 *
 * `sessionType`, `ministryId`, `eventId`, and `branchId` are all absent: changing
 * what a session *is* after people have been marked present would silently
 * re-attribute their attendance. Correcting a mistake means deleting the session
 * and opening the right one.
 *
 * `status` is here, because closing and reopening a session is an update — the
 * only one that changes who may touch the register.
 */
export const sessionUpdateSchema = applySessionRules(
  z
    .object(sessionFields)
    .omit({ branchId: true, sessionType: true, ministryId: true, eventId: true })
    .extend({ status: z.enum(SESSION_STATUSES) })
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' }),
);

/**
 * One attendance record. Either a member or a named guest, never both — mirroring
 * the `attendance_records_subject` CHECK.
 */
const recordFields = z
  .object({
    memberId: z.string().uuid('Choose a member.').nullish(),
    guestName: z
      .string()
      .trim()
      .min(2, 'Enter the guest’s name.')
      .max(120, 'That name is too long.')
      .nullish(),
    status: z.enum(ATTENDANCE_STATUSES).default('present'),
    method: z.enum(ATTENDANCE_METHODS).default('manual'),
    notes: optionalText(500),
  })
  .strict()
  .refine((value) => Boolean(value.memberId) !== Boolean(value.guestName), {
    message: 'Record either a member or a guest name, not both.',
    path: ['memberId'],
  });

/**
 * The register is written in bulk: an usher marks forty people, not one.
 *
 * A single object is accepted too, and normalised to an array — so the endpoint
 * has one code path and the caller has the convenient shape.
 *
 * The cap is 200 per request: enough for a whole service in one call, small enough
 * that a runaway client cannot post the entire roll.
 */
export const recordsCreateSchema = z.union([
  recordFields.transform((value) => [value]),
  z
    .array(recordFields)
    .min(1, 'Nothing to record.')
    .max(200, 'Record at most 200 people per request.'),
  z
    .object({
      records: z
        .array(recordFields)
        .min(1, 'Nothing to record.')
        .max(200, 'Record at most 200 people per request.'),
    })
    .strict()
    .transform((value) => value.records),
]);

export const recordUpdateSchema = z
  .object({
    status: z.enum(ATTENDANCE_STATUSES).optional(),
    notes: optionalText(500),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' });

export const SESSION_SORTS = Object.freeze({
  date: 'session_date',
  title: 'title',
  created: 'created_at',
});

export function toSessionRow(input) {
  const columns = {
    branch_id: input.branchId,
    session_type: input.sessionType,
    title: input.title,
    session_date: input.sessionDate,
    start_time: input.startTime,
    end_time: input.endTime,
    ministry_id: input.ministryId,
    event_id: input.eventId,
    status: input.status,
    count_adults: input.countAdults,
    count_youth: input.countYouth,
    count_children: input.countChildren,
    count_visitors: input.countVisitors,
    notes: input.notes,
  };

  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

export function toRecordRow(input) {
  const columns = {
    member_id: input.memberId ?? null,
    guest_name: input.guestName ?? null,
    status: input.status,
    method: input.method,
    notes: input.notes,
  };

  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

export function toSessionView(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    sessionType: row.session_type,
    title: row.title,
    sessionDate: row.session_date,
    startTime: row.start_time ? String(row.start_time).slice(0, 5) : null,
    endTime: row.end_time ? String(row.end_time).slice(0, 5) : null,
    ministryId: row.ministry_id,
    ministryName: row.ministries?.name ?? null,
    eventId: row.event_id,
    eventTitle: row.events?.title ?? null,
    status: row.status,
    headcount: {
      adults: row.count_adults,
      youth: row.count_youth,
      children: row.count_children,
      visitors: row.count_visitors,
      total: row.count_total,
    },
    notes: row.notes,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toSessionListView(row) {
  const named = Array.isArray(row.attendance_records)
    ? (row.attendance_records[0]?.count ?? 0)
    : null;

  return {
    id: row.id,
    sessionType: row.session_type,
    title: row.title,
    sessionDate: row.session_date,
    status: row.status,
    ministryId: row.ministry_id,
    ministryName: row.ministries?.name ?? null,
    headcountTotal: row.count_total,
    // Deliberately reported alongside the headcount rather than instead of it
    // (decision D5): "212 present, 148 identified".
    namedCount: named,
  };
}

export function toRecordView(row) {
  const member = row.members ?? {};
  return {
    id: row.id,
    memberId: row.member_id,
    memberNo: member.member_no ?? null,
    fullName: member.full_name ?? row.guest_name ?? null,
    isGuest: row.member_id === null,
    guestName: row.guest_name,
    status: row.status,
    method: row.method,
    checkInAt: row.check_in_at,
    notes: row.notes,
  };
}

/** A member's own attendance history, as the member detail page shows it. */
export function toHistoryView(row) {
  const session = row.attendance_sessions ?? {};
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionTitle: session.title ?? null,
    sessionDate: session.session_date ?? null,
    sessionType: session.session_type ?? null,
    status: row.status,
    checkInAt: row.check_in_at,
  };
}
