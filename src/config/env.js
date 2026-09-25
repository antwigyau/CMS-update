/**
 * Environment configuration with fail-fast validation.
 *
 * Two tiers, deliberately:
 *
 *   - Application settings always have a safe local default, so `npm run dev`
 *     works on a clean checkout.
 *   - The Supabase group is *optional at import time* but *required before use*.
 *     That lets Phase 1 run and be tested before a Supabase project exists,
 *     while `assertDeployedConfig()` makes a deployed environment fail loudly at
 *     cold start rather than silently at 2am on the first login attempt.
 *
 * Every variable here is server-side only. Nothing in this file is ever sent to
 * the browser.
 */

import { z } from 'zod';
import { configError } from '../lib/errors.js';

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

/** An absolute http(s) URL with no path, query, or trailing slash. */
function isBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.pathname === '/' && !value.endsWith('/') && !url.search && !url.hash;
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    // http is allowed only for a local Supabase stack.
    return (
      url.protocol === 'https:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    );
  } catch {
    return false;
  }
}

const schema = z.object({
  APP_URL: z
    .string()
    .refine(
      isBaseUrl,
      'must be an absolute http(s) URL with no trailing slash, e.g. https://church.example',
    )
    .default('http://localhost:3000'),
  SESSION_COOKIE_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,15}$/, 'must be 2-16 lowercase letters, digits or underscores')
    .default('cma'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  SUPABASE_URL: z.string().refine(isHttpsUrl, 'must be the https project URL').optional(),
  SUPABASE_ANON_KEY: z.string().min(20, 'looks too short to be a Supabase key').optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, 'looks too short to be a Supabase key').optional(),
});

/** Treat blank strings as absent — Vercel and dotenv both produce them. */
function compact(source) {
  const out = {};
  for (const key of Object.keys(schema.shape)) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
  }
  return out;
}

export function loadConfig(source = process.env) {
  const result = schema.safeParse(compact(source));

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    // The message names variables, never values.
    throw configError(`Invalid environment configuration — ${issues}`);
  }

  const env = result.data;
  const deployment = source.VERCEL_ENV ?? null; // 'production' | 'preview' | 'development' | null

  const supabase = Object.freeze({
    url: env.SUPABASE_URL ?? null,
    anonKey: env.SUPABASE_ANON_KEY ?? null,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? null,
    configured: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
    adminConfigured: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
  });

  return Object.freeze({
    appUrl: env.APP_URL,
    cookiePrefix: env.SESSION_COOKIE_PREFIX,
    logLevel: env.LOG_LEVEL,
    deployment,
    isDeployed: deployment !== null,
    isProduction: deployment === 'production',
    supabase,
  });
}

export const config = loadConfig();

/**
 * Call once at cold start in a deployed environment. A deployment missing its
 * database credentials is broken, and should say so in the logs immediately
 * instead of returning confusing 500s on the first authenticated request.
 */
export function assertDeployedConfig(cfg = config) {
  if (!cfg.isDeployed) return;

  const missing = [];
  if (!cfg.supabase.url) missing.push('SUPABASE_URL');
  if (!cfg.supabase.anonKey) missing.push('SUPABASE_ANON_KEY');
  if (!cfg.supabase.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length > 0) {
    throw configError(
      `Deployment "${cfg.deployment}" is missing required environment variables: ${missing.join(', ')}`,
    );
  }
}

/** Guard for any code path that needs a user-scoped Supabase client. */
export function requireSupabaseConfig(cfg = config) {
  if (!cfg.supabase.configured) {
    throw configError('Supabase is not configured — set SUPABASE_URL and SUPABASE_ANON_KEY');
  }
  return cfg.supabase;
}

/** Guard for the few allow-listed code paths that need the service-role key. */
export function requireSupabaseAdminConfig(cfg = config) {
  if (!cfg.supabase.adminConfigured) {
    throw configError(
      'Supabase admin access is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
    );
  }
  return cfg.supabase;
}
