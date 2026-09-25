/**
 * Settings: the church-wide key/value rows an administrator edits in-app.
 *
 * Only global settings are exposed here — the per-branch scope exists in the
 * schema but has no MVP surface. Reads and writes both ride on RLS: the
 * `settings_write` policy already demands `settings.manage`, so this service adds
 * no authorization of its own beyond selecting the right rows.
 *
 * `updated_by` has no database trigger behind it (unlike `updated_at`), so the
 * caller stamps it explicitly from the session — otherwise the column would drift
 * to null on every edit.
 */

import { createUserClient } from '../data/supabase-user.js';
import { unwrap } from '../data/errors.js';
import { notFound } from '../lib/errors.js';

const COLUMNS = 'id, scope, branch_id, key, value, description, is_public, updated_at';

export function createSettingsService({ getClient = createUserClient } = {}) {
  async function list({ accessToken }) {
    const result = await getClient(accessToken)
      .from('settings')
      .select(COLUMNS)
      .eq('scope', 'global')
      .order('key', { ascending: true });

    return unwrap(result, { resource: 'setting' }) ?? [];
  }

  async function update({ accessToken, key, value, updatedBy }) {
    const result = await getClient(accessToken)
      .from('settings')
      .update({ value, updated_by: updatedBy })
      .eq('scope', 'global')
      .eq('key', key)
      .select(COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'setting' });
    if (!row) throw notFound('That setting does not exist.');
    return row;
  }

  return { list, update };
}
