/**
 * Ministry payload validation.
 *
 * `meeting_day` is stored as an ISO-8601 weekday number (1 = Monday … 7 = Sunday)
 * rather than a name, so it sorts and compares without a lookup and does not
 * depend on the reader's language. The UI turns it back into a word.
 *
 * Leadership is deliberately NOT a field here. A leader is a `ministry_members`
 * row with `role_in_ministry = 'leader'`, for the same reason a household head is
 * a membership row (ADR-038): a `leader_member_id` column would duplicate it and
 * the two would eventually disagree.
 */

import { z } from 'zod';

export const MINISTRY_STATUSES = ['active', 'inactive'];
export const MINISTRY_ROLES = ['leader', 'assistant_leader', 'member'];

export const WEEKDAYS = Object.freeze([
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
]);

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max, `Keep this to ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullish();

/** `HH:MM`, or `HH:MM:SS` as PostgreSQL returns it. */
const optionalTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Enter a time as HH:MM, for example 18:30.')
  .transform((value) => (value === '' ? null : value.slice(0, 5)))
  .nullish();

/** No defaults in the shared field set — ADR-033. */
const ministryFields = {
  branchId: z.string().uuid('Choose a branch.'),
  name: z
    .string()
    .trim()
    .min(2, 'Enter a name for this ministry.')
    .max(120, 'That name is too long.'),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_-]{1,15}$/, 'Use 2–16 letters, digits, hyphens or underscores.')
    .transform((value) => (value === '' ? null : value))
    .nullish(),
  description: optionalText(2000),
  status: z.enum(MINISTRY_STATUSES),
  meetingDay: z.coerce
    .number()
    .int('Choose a day of the week.')
    .min(1, 'Choose a day of the week.')
    .max(7, 'Choose a day of the week.')
    .nullish(),
  meetingTime: optionalTime,
  meetingLocation: optionalText(240),
};

export const ministryCreateSchema = z
  .object({ ...ministryFields, status: ministryFields.status.default('active') })
  .strict();

export const ministryUpdateSchema = z
  .object(ministryFields)
  .omit({ branchId: true })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' });

export const ministryMemberAddSchema = z
  .object({
    memberId: z.string().uuid('Choose a member.'),
    roleInMinistry: z.enum(MINISTRY_ROLES).default('member'),
    joinedOn: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date joined as YYYY-MM-DD.')
      .nullish(),
  })
  .strict();

export const ministryMemberUpdateSchema = z
  .object({
    roleInMinistry: z.enum(MINISTRY_ROLES).optional(),
    /**
     * Setting `leftOn` is how someone leaves a ministry. The row is kept, because
     * past membership explains past attendance and past leadership — so there is
     * no DELETE for a membership that has history.
     */
    leftOn: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date left as YYYY-MM-DD.')
      .nullable()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' });

export const MINISTRY_SORTS = Object.freeze({
  name: 'name',
  status: 'status',
  created: 'created_at',
});

export function toMinistryRow(input) {
  const columns = {
    branch_id: input.branchId,
    name: input.name,
    code: input.code,
    description: input.description,
    status: input.status,
    meeting_day: input.meetingDay,
    meeting_time: input.meetingTime,
    meeting_location: input.meetingLocation,
  };

  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

export function toMinistryMemberRow(input) {
  const columns = {
    member_id: input.memberId,
    role_in_ministry: input.roleInMinistry,
    joined_on: input.joinedOn,
    left_on: input.leftOn,
  };

  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

export function toMinistryView(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    name: row.name,
    code: row.code,
    description: row.description,
    status: row.status,
    meetingDay: row.meeting_day,
    meetingTime: row.meeting_time ? String(row.meeting_time).slice(0, 5) : null,
    meetingLocation: row.meeting_location,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toMinistryListView(row) {
  const count = Array.isArray(row.ministry_members)
    ? (row.ministry_members[0]?.count ?? 0)
    : (row.member_count ?? null);

  return {
    id: row.id,
    name: row.name,
    code: row.code,
    status: row.status,
    meetingDay: row.meeting_day,
    meetingTime: row.meeting_time ? String(row.meeting_time).slice(0, 5) : null,
    memberCount: count,
  };
}

export function toMinistryMemberView(row) {
  const member = row.members ?? {};
  return {
    id: row.id,
    memberId: row.member_id,
    memberNo: member.member_no ?? null,
    fullName: member.full_name ?? null,
    membershipStatus: member.membership_status ?? null,
    photoPath: member.photo_path ?? null,
    roleInMinistry: row.role_in_ministry,
    joinedOn: row.joined_on,
    leftOn: row.left_on,
    isActive: row.left_on === null,
  };
}
