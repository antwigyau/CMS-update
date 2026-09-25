/**
 * Emergency-contact payload validation.
 *
 * Kept in step with the CHECK constraints in `20260826120600_members.sql`
 * (`member_emergency_contacts`). `.strict()`, like every other schema, so an
 * unknown key is a 422 rather than a silent write.
 *
 * There is no `branchId` and no `memberId` field: the contact belongs to the
 * member in the path, and RLS decides visibility through `app.can_edit_member`.
 */

import { z } from 'zod';

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max, `Keep this to ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullish();

const requiredPhone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()./-]{6,19}$/, 'Enter a valid phone number.');

const optionalPhone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()./-]{6,19}$/, 'Enter a valid alternative phone number.')
  .transform((value) => (value === '' ? null : value))
  .nullish();

const contactFields = {
  name: z.string().trim().min(2, 'Enter the contact’s name.').max(120, 'That name is too long.'),
  relationship: z
    .string()
    .trim()
    .min(2, 'Say how they are related, for example “Spouse”.')
    .max(60, 'That relationship is too long.'),
  phone: requiredPhone,
  altPhone: optionalPhone,
  addressLine: optionalText(240),
  isPrimary: z.boolean(),
};

export const emergencyContactCreateSchema = z
  .object({ ...contactFields, isPrimary: contactFields.isPrimary.default(false) })
  .strict();

export const emergencyContactUpdateSchema = z
  .object(contactFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' });

export function toEmergencyContactRow(input) {
  const columns = {
    name: input.name,
    relationship: input.relationship,
    phone: input.phone,
    alt_phone: input.altPhone,
    address_line: input.addressLine,
    is_primary: input.isPrimary,
  };
  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

export function toEmergencyContactView(row) {
  return {
    id: row.id,
    memberId: row.member_id,
    name: row.name,
    relationship: row.relationship,
    phone: row.phone,
    altPhone: row.alt_phone,
    addressLine: row.address_line,
    isPrimary: row.is_primary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
