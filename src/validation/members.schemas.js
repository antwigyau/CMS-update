/**
 * Member payload validation.
 *
 * Field set from §13 of the specification and decision D7. Kept in step with the
 * database constraints in `20260826120600_members.sql` — where the two overlap
 * (a future date of birth, a baptism date without baptism) the check is in both
 * places on purpose: zod produces a message naming the field, and the constraint
 * is what cannot be bypassed.
 *
 * `.strict()` everywhere, so an unknown key is a 422. That is what makes a mass
 * assignment attempt an error rather than a silent no-op — and it catches typos
 * in our own frontend during development.
 */

import { z } from 'zod';

/** Trim, and treat a field the user cleared as absent rather than as "". */
const optionalText = (max, message) =>
  z
    .string()
    .trim()
    .max(max, message ?? `Keep this to ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullish();

const requiredName = (label) =>
  z.string().trim().min(1, `Enter the member's ${label}.`).max(80, `That ${label} is too long.`);

/** ISO date, no time. Rejects '2026-02-31' rather than rolling it over. */
const isoDate = (label) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `Enter ${label} as YYYY-MM-DD.`)
    .refine((value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
    }, `That is not a real date.`)
    .transform((value) => (value === '' ? null : value))
    .nullish();

const phone = (label) =>
  z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 ()./-]{6,19}$/, `Enter a valid ${label}.`)
    .transform((value) => (value === '' ? null : value))
    .nullish();

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'That email address is too long.')
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'Enter a valid email address.')
  .transform((value) => (value === '' ? null : value))
  .nullish();

export const GENDERS = ['male', 'female'];
export const MARITAL_STATUSES = ['single', 'married', 'widowed', 'divorced', 'separated'];
export const MEMBERSHIP_STATUSES = [
  'visitor',
  'new',
  'active',
  'inactive',
  'transferred',
  'deceased',
];

/**
 * The field set, with NO defaults.
 *
 * Defaults are added only to the create schema. This matters: `.partial()` does
 * not strip a `.default()`, so a field carrying one would still be produced by a
 * PATCH that omitted it — silently resetting `membershipStatus` to 'visitor' and
 * `isBaptized` to false on every edit. A test now covers exactly that.
 */
const memberFields = {
  branchId: z.string().uuid('Choose a branch.'),

  firstName: requiredName('first name'),
  middleName: optionalText(80),
  lastName: requiredName('last name'),
  gender: z.enum(GENDERS).nullish(),
  dateOfBirth: isoDate('the date of birth'),
  maritalStatus: z.enum(MARITAL_STATUSES).nullish(),
  occupation: optionalText(120),

  phone: phone('phone number'),
  altPhone: phone('alternative phone number'),
  email,
  addressLine: optionalText(240),
  city: optionalText(120),
  region: optionalText(120),
  country: optionalText(120),
  nationality: optionalText(120),

  membershipStatus: z.enum(MEMBERSHIP_STATUSES),
  dateJoined: isoDate('the date joined'),
  isBaptized: z.boolean(),
  baptismDate: isoDate('the baptism date'),
  notes: optionalText(4000, 'Keep notes to 4000 characters or fewer.'),
};

/**
 * Rules that span two fields, so they cannot live on a single field's schema.
 * Each mirrors a CHECK constraint; the database is the one that cannot be
 * bypassed, this is the one that says which field to fix.
 */
function applyCrossFieldRules(schema) {
  return schema
    .refine(
      (value) => !value.dateOfBirth || value.dateOfBirth <= new Date().toISOString().slice(0, 10),
      { message: 'A date of birth cannot be in the future.', path: ['dateOfBirth'] },
    )
    .refine((value) => !value.baptismDate || value.isBaptized === true, {
      message: 'Mark the member as baptised before recording a baptism date.',
      path: ['baptismDate'],
    })
    .refine(
      (value) => !value.baptismDate || !value.dateOfBirth || value.baptismDate >= value.dateOfBirth,
      { message: 'A baptism date cannot be before the date of birth.', path: ['baptismDate'] },
    )
    .refine(
      (value) => !value.dateJoined || !value.dateOfBirth || value.dateJoined >= value.dateOfBirth,
      { message: 'The date joined cannot be before the date of birth.', path: ['dateJoined'] },
    );
}

export const memberCreateSchema = applyCrossFieldRules(
  z
    .object({
      ...memberFields,
      // Defaults belong here and only here — see the note on memberFields.
      membershipStatus: memberFields.membershipStatus.default('visitor'),
      isBaptized: memberFields.isBaptized.default(false),
    })
    .strict(),
);

/**
 * Update is a partial, and deliberately does NOT include `branchId`.
 *
 * Moving a member between branches changes who can see them, so it is a separate
 * privileged operation rather than a field on an edit form. A database trigger
 * refuses it without `branches.manage` even if this schema were widened.
 */
export const memberUpdateSchema = applyCrossFieldRules(
  z
    .object(memberFields)
    .omit({ branchId: true })
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
      message: 'No changes were supplied.',
    }),
);

/** Sort keys the member list offers, mapped to real columns. */
export const MEMBER_SORTS = Object.freeze({
  name: 'last_name',
  joined: 'date_joined',
  number: 'member_no',
  status: 'membership_status',
  created: 'created_at',
});

/**
 * Map a validated payload to database column names.
 *
 * Kept as an explicit list rather than a camel-to-snake helper: an automatic
 * conversion would happily forward a field that should not be writable, which is
 * exactly the bug `.strict()` exists to prevent.
 */
export function toMemberRow(input) {
  const columns = {
    branch_id: input.branchId,
    first_name: input.firstName,
    middle_name: input.middleName,
    last_name: input.lastName,
    gender: input.gender,
    date_of_birth: input.dateOfBirth,
    marital_status: input.maritalStatus,
    occupation: input.occupation,
    phone: input.phone,
    alt_phone: input.altPhone,
    email: input.email,
    address_line: input.addressLine,
    city: input.city,
    region: input.region,
    country: input.country,
    nationality: input.nationality,
    membership_status: input.membershipStatus,
    date_joined: input.dateJoined,
    is_baptized: input.isBaptized,
    baptism_date: input.baptismDate,
    notes: input.notes,
  };

  // Only the keys the caller actually supplied, so a PATCH does not blank every
  // field it omitted.
  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

/** The shape sent to the browser. Explicit, so a new column is never leaked by default. */
export function toMemberView(row) {
  return {
    id: row.id,
    memberNo: row.member_no,
    branchId: row.branch_id,
    firstName: row.first_name,
    middleName: row.middle_name,
    lastName: row.last_name,
    fullName: row.full_name,
    gender: row.gender,
    dateOfBirth: row.date_of_birth,
    maritalStatus: row.marital_status,
    occupation: row.occupation,
    phone: row.phone,
    altPhone: row.alt_phone,
    email: row.email,
    addressLine: row.address_line,
    city: row.city,
    region: row.region,
    country: row.country,
    nationality: row.nationality,
    membershipStatus: row.membership_status,
    dateJoined: row.date_joined,
    isBaptized: row.is_baptized,
    baptismDate: row.baptism_date,
    photoPath: row.photo_path,
    notes: row.notes,
    hasLogin: Boolean(row.user_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The narrower shape used in a list, so a page of 100 is not 100 full records. */
export function toMemberListView(row) {
  return {
    id: row.id,
    memberNo: row.member_no,
    fullName: row.full_name,
    gender: row.gender,
    phone: row.phone,
    email: row.email,
    city: row.city,
    membershipStatus: row.membership_status,
    dateJoined: row.date_joined,
    photoPath: row.photo_path,
  };
}
