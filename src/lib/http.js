/**
 * HTTP response helpers.
 *
 * Every API response has one of exactly two shapes:
 *
 *   success:  { "data": <payload>, "meta": { ... } }   // meta only when paginated
 *   failure:  { "error": { "code", "message", "details"?, "requestId" } }
 *
 * A single shape means the frontend needs one error path, not one per endpoint.
 */

import { API_HEADERS } from './security-headers.js';
import { toAppError } from './errors.js';

export function jsonResponse(body, { status = 200, headers } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...API_HEADERS, ...headers },
  });
}

export function ok(data, meta) {
  return jsonResponse(meta === undefined ? { data } : { data, meta });
}

export function created(data, { location } = {}) {
  return jsonResponse(
    { data },
    { status: 201, headers: location ? { Location: location } : undefined },
  );
}

export function noContent() {
  // 204 must not carry a body; the JSON content-type would be a lie.
  const { 'Content-Type': _contentType, ...headers } = API_HEADERS;
  return new Response(null, { status: 204, headers });
}

/**
 * A downloadable file — a report export, today only CSV.
 *
 * Keeps every security header (including `nosniff`, so the browser will not
 * reinterpret the body) and swaps the JSON content type for the real one. The
 * `Content-Disposition` makes it a download rather than something the browser
 * tries to render; the filename is always server-chosen, so it needs no escaping.
 */
export function fileResponse(body, { contentType, filename }) {
  return new Response(body, {
    status: 200,
    headers: {
      ...API_HEADERS,
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

/**
 * Turn a thrown value into a client response, and log the diagnostic half.
 * This is the ONLY place an error becomes a response, which is what keeps stack
 * traces and database messages out of the browser (§37).
 */
export function toErrorResponse(thrown, { requestId, logger } = {}) {
  const error = toAppError(thrown);

  if (logger) {
    const level = error.status >= 500 ? 'error' : 'warn';
    logger[level]('request failed', { code: error.code, status: error.status, error });
  }

  return jsonResponse(error.toClientJson(requestId), { status: error.status });
}
