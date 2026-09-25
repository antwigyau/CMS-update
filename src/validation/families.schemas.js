/**
 * Family payload validation.
 *
 * A "family" here is a household: the people who live together and share a
 * contact address, which is what a church actually needs for visiting and for
 * addressing correspondence. It is deliberately not a genealogy — the
 * relationships are relative to the household head, not a full family tree.
 *
 * Two rules are enforced by partial unique index in the database and mirrored in
 * the messages here: at most one head per household, and a member belongs to at
 * most one household. Both are assumptions about how households work rather than
 * instructions from the church, and both are one dropped index away from being
 * relaxed (see docs/DATABASE.md).
 */

import { z } from 'zod';

export const FAMILY_RELATIONSHIPS = [
  'head',
  'spouse',
  'son',
  'daughter',
  'father',
  'mother',
  'brother',
  'sister',
  'grandparent',
  'grandchild',
  'other',
];

/** Trim, and treat a field the user cleared as absent rather than as "". */
const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max, `Keep this to ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullish();

const optionalPhone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()./-]{6,19}$/, 'Enter a valid phone number.')
  .transform((value) => (value === '' ? null : value))
  .nullish();

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'That email address is too long.')
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'Enter a valid email address.')
  .transform((value) => (value === '' ? null : value))
  .nullish();

/** No defaults here — see ADR-033 on why they belong only on the create schema. */
const familyFields = {
  branchId: z.string().uuid('Choose a branch.'),
  familyName: z
    .string()
    .trim()
    .min(2, 'Enter a name for this household, for example "The Mensah Family".')
    .max(120, 'That name is too long.'),
  householdPhone: optionalPhone,
  householdEmail: optionalEmail,
  addressLine: optionalText(240),
  city: optionalText(120),
  region: optionalText(120),
  country: optionalText(120),
  notes: optionalText(2000),
};

export const familyCreateSchema = z.object(familyFields).strict();

/** `branchId` is omitted for the same reason as on members: moving a household
 * between branches changes who can see it, and the composite foreign keys would
 * have to move every member with it. It is not an edit-form field. */
export const familyUpdateSchema = z
  .object(familyFields)
  .omit({ branchId: true })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' });

export const familyMemberAddSchema = z
  .object({
    memberId: z.string().uuid('Choose a member.'),
    relationship: z.enum(FAMILY_RELATIONSHIPS, {
      message: 'Choose how this person is related to the household.',
    }),
    isDependent: z.boolean().default(false),
  })
  .strict();

export const familyMemberUpdateSchema = z
  .object({
    relationship: z.enum(FAMILY_RELATIONSHIPS).optional(),
    isDependent: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' });

/** Sort keys the family list offers, mapped to real columns. */
export const FAMILY_SORTS = Object.freeze({
  name: 'family_name',
  created: 'created_at',
  city: 'city',
});

export function toFamilyRow(input) {
  const columns = {
    branch_id: input.branchId,
    family_name: input.familyName,
    household_phone: input.householdPhone,
    household_email: input.householdEmail,
    address_line: input.addressLine,
    city: input.city,
    region: input.region,
    country: input.country,
    notes: input.notes,
  };

  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

export function toFamilyMemberRow(input) {
  const columns = {
    member_id: input.memberId,
    relationship: input.relationship,
    is_dependent: input.isDependent,
  };

  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

export function toFamilyView(row) {
  return {
    id: row.id,
    branchId: row.branch_id,
    familyName: row.family_name,
    householdPhone: row.household_phone,
    householdEmail: row.household_email,
    addressLine: row.address_line,
    city: row.city,
    region: row.region,
    country: row.country,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A household in a list. `memberCount` is present only when the caller asked for
 * it; PostgREST returns an aggregate as an array of one object.
 */
export function toFamilyListView(row) {
  const count = Array.isArray(row.family_members)
    ? (row.family_members[0]?.count ?? 0)
    : (row.member_count ?? null);

  return {
    id: row.id,
    familyName: row.family_name,
    householdPhone: row.household_phone,
    city: row.city,
    memberCount: count,
  };
}

/** One person's place in a household, as the detail page shows it. */
export function toFamilyMemberView(row) {
  const member = row.members ?? {};
  return {
    memberId: row.member_id,
    memberNo: member.member_no ?? null,
    fullName: member.full_name ?? null,
    membershipStatus: member.membership_status ?? null,
    photoPath: member.photo_path ?? null,
    dateOfBirth: member.date_of_birth ?? null,
    relationship: row.relationship,
    isDependent: row.is_dependent,
  };
}
