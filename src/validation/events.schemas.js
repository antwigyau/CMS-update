/**
 * Event payload validation.
 *
 * `startsAt` and `endsAt` are `timestamptz`: an event happens at an instant, not a
 * wall-clock time, so a 6pm service is the same moment for everyone reading about
 * it. That is the opposite of a ministry's *meeting time* (ADR — see
 * `formatTime` in core/format.js), which is a recurring wall-clock time and is
 * stored as a plain `time`.
 *
 * The distinction matters for the frontend: an event datetime is converted to the
 * reader's zone, a meeting time is not.
 */

import { z } from 'zod';

export const EVENT_STATUSES = ['draft', 'published', 'ongoing', 'completed', 'cancelled'];
export const REGISTRATION_STATUSES = ['registered', 'cancelled', 'no_show'];

/** Statuses at which an event is visible to someone who only holds `events.view`. */
export const PUBLISHED_STATUSES = ['published', 'ongoing', 'completed'];

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max, `Keep this to ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullish();

/**
 * An ISO-8601 instant. Accepts what `<input type="datetime-local">` produces
 * (`2026-09-06T18:00`) as well as a full offset, and normalises to an ISO string.
 *
 * A bare local datetime is interpreted in the *server's* zone, which is UTC on
 * Vercel — so the frontend sends an explicit offset. That is checked by a test, and
 * noted here because the failure mode is subtle: an event that appears an hour out.
 */
const instant = (label) =>
  z
    .string()
    .trim()
    .min(1, `Enter ${label}.`)
    .refine(
      (value) => !Number.isNaN(new Date(value).getTime()),
      `Enter ${label} as a date and time.`,
    )
    .transform((value) => new Date(value).toISOString());

const eventFields = {
  branchId: z.string().uuid('Choose a branch.'),
  categoryId: z.string().uuid('Choose a category.').nullish(),
  title: z.string().trim().min(2, 'Give this event a title.').max(160, 'That title is too long.'),
  description: optionalText(8000),
  startsAt: instant('when the event starts'),
  endsAt: instant('when the event ends'),
  venue: optionalText(240),
  ministryId: z.string().uuid('Choose a ministry.').nullish(),
  organizerMemberId: z.string().uuid('Choose an organiser.').nullish(),
  /**
   * `isPublic` widens visibility to every signed-in user, including the Guest
   * role. It is not a status: a draft is never visible however public it claims to
   * be, which the RLS policy enforces.
   */
  isPublic: z.boolean(),
  capacity: z.coerce
    .number()
    .int('Enter a whole number.')
    .min(1, 'A capacity of zero would mean nobody can attend.')
    .max(1_000_000, 'That capacity is implausibly large.')
    .nullish(),
};

function applyEventRules(schema) {
  return schema.refine(
    (value) =>
      !value.startsAt || !value.endsAt || new Date(value.endsAt) > new Date(value.startsAt),
    { message: 'The event must end after it starts.', path: ['endsAt'] },
  );
}

export const eventCreateSchema = applyEventRules(
  z.object({ ...eventFields, isPublic: eventFields.isPublic.default(false) }).strict(),
);

/**
 * Update.
 *
 * `status` is deliberately absent. Publishing is a separate permission
 * (`events.publish`) and therefore a separate endpoint — see ADR-049. Cancelling
 * and completing go through the same endpoint for the same reason: they are
 * lifecycle transitions, not field edits.
 */
export const eventUpdateSchema = applyEventRules(
  z
    .object(eventFields)
    .omit({ branchId: true })
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' }),
);

/** The lifecycle endpoint. One field, so the intent is unambiguous in a log. */
export const eventStatusSchema = z
  .object({ status: z.enum(EVENT_STATUSES, { message: 'Choose a valid event status.' }) })
  .strict();

export const registrationCreateSchema = z
  .object({
    memberId: z.string().uuid('Choose a member.').nullish(),
    guestName: z
      .string()
      .trim()
      .min(2, 'Enter the guest’s name.')
      .max(120, 'That name is too long.')
      .nullish(),
    guestPhone: z
      .string()
      .trim()
      .regex(/^\+?[0-9][0-9 ()./-]{6,19}$/, 'Enter a valid phone number.')
      .transform((value) => (value === '' ? null : value))
      .nullish(),
    guestEmail: z
      .string()
      .trim()
      .toLowerCase()
      .max(254, 'That email address is too long.')
      .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'Enter a valid email address.')
      .transform((value) => (value === '' ? null : value))
      .nullish(),
    notes: optionalText(500),
  })
  .strict()
  .refine((value) => Boolean(value.memberId) !== Boolean(value.guestName), {
    message: 'Register either a member or a guest name, not both.',
    path: ['memberId'],
  })
  .refine((value) => !value.memberId || (!value.guestPhone && !value.guestEmail), {
    message: 'A member’s contact details come from their record.',
    path: ['guestPhone'],
  });

export const registrationUpdateSchema = z
  .object({
    status: z.enum(REGISTRATION_STATUSES).optional(),
    notes: optionalText(500),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' });

export const EVENT_SORTS = Object.freeze({
  starts: 'starts_at',
  title: 'title',
  created: 'created_at',
});

export function toEventRow(input) {
  const columns = {
    branch_id: input.branchId,
    category_id: input.categoryId,
    title: input.title,
    description: input.description,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    venue: input.venue,
    ministry_id: input.ministryId,
    organizer_member_id: input.organizerMemberId,
    is_public: input.isPublic,
    capacity: input.capacity,
    status: input.status,
  };

  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

export function toRegistrationRow(input) {
  const columns = {
    member_id: input.memberId ?? null,
    guest_name: input.guestName ?? null,
    guest_phone: input.guestPhone ?? null,
    guest_email: input.guestEmail ?? null,
    notes: input.notes,
    status: input.status,
  };

  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

export function toEventView(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    categoryId: row.category_id,
    categoryName: row.event_categories?.name ?? null,
    categoryColour: row.event_categories?.colour ?? null,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    venue: row.venue,
    ministryId: row.ministry_id,
    ministryName: row.ministries?.name ?? null,
    organizerMemberId: row.organizer_member_id,
    organizerName: row.members?.full_name ?? null,
    status: row.status,
    isPublic: row.is_public,
    capacity: row.capacity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toEventListView(row) {
  const registered = Array.isArray(row.event_registrations)
    ? (row.event_registrations[0]?.count ?? 0)
    : null;

  return {
    id: row.id,
    title: row.title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    venue: row.venue,
    status: row.status,
    isPublic: row.is_public,
    capacity: row.capacity,
    categoryName: row.event_categories?.name ?? null,
    categoryColour: row.event_categories?.colour ?? null,
    ministryName: row.ministries?.name ?? null,
    registeredCount: registered,
  };
}

export function toRegistrationView(row) {
  const member = row.members ?? {};
  return {
    id: row.id,
    memberId: row.member_id,
    memberNo: member.member_no ?? null,
    fullName: member.full_name ?? row.guest_name ?? null,
    isGuest: row.member_id === null,
    guestName: row.guest_name,
    guestPhone: row.guest_phone,
    guestEmail: row.guest_email,
    status: row.status,
    notes: row.notes,
    registeredAt: row.registered_at,
  };
}

export function toCategoryView(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    colour: row.colour,
    isActive: row.is_active,
  };
}
