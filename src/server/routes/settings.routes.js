/**
 * Settings endpoints — the in-app home for church-wide configuration.
 *
 *   GET   /api/admin/settings        list the global settings   (settings.manage)
 *   PATCH /api/admin/settings/:key   change one setting's value  (settings.manage)
 *
 * Both are gated on `settings.manage`, not `settings.view`. The distinction is
 * deliberate: `settings.view` is an RLS read grant that lets a role see non-public
 * settings elsewhere, but the *editing* screen belongs to whoever may change them.
 * The single Administration nav link is `settings.manage`, so gating the list on
 * `view` would let a role open a page whose every control 403s.
 *
 * The `:key` segment carries dotted keys like `finance.currency` whole — the
 * router matches a path segment, and dots live inside one segment.
 */

import { ok } from '../../lib/http.js';
import { validate } from '../../validation/index.js';
import { settingUpdateSchema, toSettingView } from '../../validation/settings.schemas.js';

export function registerSettingsRoutes(router, { settings, audit }) {
  async function list(context) {
    const rows = await settings.list({ accessToken: context.session.accessToken });
    return ok(rows.map(toSettingView));
  }

  async function update(context) {
    const input = validate(settingUpdateSchema, await context.json());
    const row = await settings.update({
      accessToken: context.session.accessToken,
      key: context.params.key,
      value: input.value,
      updatedBy: context.session.userId,
    });

    context.logger.info('setting updated', { key: row.key });
    await audit.record(context, {
      action: 'setting.updated',
      resourceType: 'setting',
      resourceId: row.id,
      changes: { key: row.key, value: row.value },
    });
    return ok(toSettingView(row));
  }

  router.get('/admin/settings', list, { permission: 'settings.manage' });
  router.patch('/admin/settings/:key', update, { permission: 'settings.manage' });
}
