/**
 * Settings payload validation.
 *
 * A setting is a `(scope, key)` row whose `value` is jsonb — so the only thing a
 * user edits through this surface is that value. Key, scope, and description are
 * fixed metadata for the MVP: correcting them is a migration or a seed change,
 * not a form field.
 *
 * The value is validated only for *shape* (a JSON scalar, object, or array), not
 * for meaning. Whether a currency code is real, or an approval flag sane, is the
 * concern of the feature that reads the setting — the finance service already
 * fails loudly on an empty or unusable `finance.currency`, so re-checking it here
 * would duplicate a rule that lives closer to where it matters.
 */

import { z } from 'zod';

/**
 * Any JSON value: the four scalars, an array, or an object. `undefined` is not
 * JSON and is rejected by omission — a missing `value` fails the required check.
 */
const jsonValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

export const settingUpdateSchema = z.object({ value: jsonValue }).strict();

/** The database row as the API exposes it — camelCase, no internal columns. */
export function toSettingView(row) {
  return {
    id: row.id,
    scope: row.scope,
    branchId: row.branch_id,
    key: row.key,
    value: row.value,
    description: row.description,
    isPublic: row.is_public,
    updatedAt: row.updated_at,
  };
}
