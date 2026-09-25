/**
 * Security response headers — the single source of truth.
 *
 * Static assets are served by Vercel's CDN, which reads its headers from
 * `vercel.json`; the API and the local dev server read them from here. Those two
 * copies can drift, so `tests/unit/security-headers.test.js` parses vercel.json
 * and asserts it matches this module. Keep both in step or that test fails.
 */

/**
 * Strict CSP. Notable choices:
 *   - no 'unsafe-inline' anywhere, which is why there is not a single inline
 *     <script> or style attribute in public/ (theme-boot.js exists for this reason)
 *   - img-src allows *.supabase.co so signed Storage URLs render directly.
 *     The alternative — proxying every photo through the API — costs a function
 *     invocation per avatar. Revisit if we ever need to hide the storage origin.
 *   - frame-ancestors 'none' rather than relying on X-Frame-Options alone
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: https://*.supabase.co",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/** Applied to every response, static or dynamic. */
export const BASE_SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
});

/** Applied to HTML documents. */
export const DOCUMENT_SECURITY_HEADERS = Object.freeze({
  ...BASE_SECURITY_HEADERS,
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
});

/** Applied to /api responses. Never cached, anywhere. */
export const API_HEADERS = Object.freeze({
  ...BASE_SECURITY_HEADERS,
  'Cache-Control': 'no-store, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
});

export const HTML_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
export const ASSET_CACHE_CONTROL = 'public, max-age=600, stale-while-revalidate=86400';
