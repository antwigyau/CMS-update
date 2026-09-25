/**
 * Connectivity probe for /api/health?deep=1.
 *
 * Hits the PostgREST root, which returns the schema document when the URL and
 * anon key are both valid. That proves network + project + key without needing
 * any table to exist, so it works from Phase 1 onward.
 *
 * The result deliberately contains booleans and a latency number only — never
 * the project URL, the key, or any upstream error text.
 */

import { config } from '../config/env.js';

export async function checkSupabaseReachable({ timeoutMs = 2500, cfg = config } = {}) {
  if (!cfg.supabase.configured) {
    return { configured: false, reachable: false, reason: 'not_configured' };
  }

  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  try {
    const response = await fetch(`${cfg.supabase.url}/rest/v1/`, {
      method: 'GET',
      headers: { apikey: cfg.supabase.anonKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    return {
      configured: true,
      reachable: response.ok,
      httpStatus: response.status,
      latencyMs: elapsed(),
    };
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'timeout' : 'network_error';
    return { configured: true, reachable: false, reason, latencyMs: elapsed() };
  }
}
