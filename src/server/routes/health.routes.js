/**
 * Health and readiness.
 *
 * GET /api/health        — liveness. Public, no I/O, no session.
 * GET /api/health/deep   — also probes Supabase connectivity. Requires
 *                          `settings.view`.
 *
 * The split exists because the deep probe makes an outbound request, so an
 * anonymous caller could use it to generate load against our own database host.
 * In Phase 1 it was a `?deep=1` query parameter refused in production, because
 * there was no permission system to guard it with. Now there is, so it is a
 * separate permissioned route and works in production for those authorised
 * (ADR-013).
 */

import { config } from '../../config/env.js';
import { checkSupabaseReachable } from '../../data/supabase-health.js';
import { ok } from '../../lib/http.js';
import { APP_NAME, APP_VERSION } from '../../lib/version.js';

function descriptor() {
  return {
    status: 'ok',
    service: APP_NAME,
    version: APP_VERSION,
    deployment: config.deployment ?? 'local',
    time: new Date().toISOString(),
    supabase: {
      configured: config.supabase.configured,
      adminConfigured: config.supabase.adminConfigured,
    },
  };
}

function health() {
  return ok(descriptor());
}

async function deepHealth({ logger }) {
  const body = descriptor();
  const probe = await checkSupabaseReachable();

  logger.info('deep health probe', { probe });

  return ok({
    ...body,
    status: probe.configured && !probe.reachable ? 'degraded' : body.status,
    supabase: { ...body.supabase, ...probe },
  });
}

export function registerHealthRoutes(router) {
  router.get('/health', health, { public: true });
  router.get('/health/deep', deepHealth, { permission: 'settings.view' });
}
