/**
 * Spiritual-gift payload validation (decision D7: a controlled list, not free
 * text). Kept in step with the constraints in `20260826120600_members.sql`.
 *
 * Two shapes: editing the shared lookup (`settings.manage`), and attaching a gift
 * to a member (`members.update`). Both `.strict()`.
 */

import { z } from 'zod';

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max, `Keep this to ${max} characters or fewer.`)
    .transform((value) => (value === '' ? null : value))
    .nullish();

const giftFields = {
  name: z.string().trim().min(2, 'Give the gift a name.').max(60, 'That name is too long.'),
  description: optionalText(2000),
  isActive: z.boolean(),
  sortOrder: z.coerce.number().int().min(0).max(1000).nullish(),
};

export const giftCreateSchema = z
  .object({ ...giftFields, isActive: giftFields.isActive.default(true) })
  .strict();

export const giftUpdateSchema = z
  .object(giftFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes were supplied.' });

export const memberGiftAddSchema = z
  .object({ giftId: z.string().uuid('Choose a gift from the list.') })
  .strict();

export function toGiftRow(input) {
  const columns = {
    name: input.name,
    description: input.description,
    is_active: input.isActive,
    sort_order: input.sortOrder,
  };
  return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

export function toGiftView(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}

/** A gift as attached to a member — the join row plus the gift's name. */
export function toMemberGiftView(row) {
  return {
    giftId: row.gift_id,
    name: row.spiritual_gifts?.name ?? null,
    description: row.spiritual_gifts?.description ?? null,
    notedAt: row.noted_at,
  };
}
