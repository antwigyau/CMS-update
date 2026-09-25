/**
 * The only place the frontend talks to the network.
 *
 * Properties worth keeping:
 *   - same-origin only. There is no Supabase URL or key in the browser, so
 *     there is nothing here to leak.
 *   - session cookies ride along automatically and are HttpOnly, so this module
 *     cannot read them even deliberately.
 *   - the CSRF token is echoed from a readable cookie into a header on every
 *     state-changing request (double-submit). A cross-site attacker can cause
 *     the cookie to be sent but cannot read it to set the header.
 *   - every failure becomes an ApiError with a stable `code`, so callers switch
 *     on codes rather than parsing messages.
 */

const CSRF_COOKIE = 'cma_csrf';
const CSRF_HEADER = 'X-CSRF-Token';
const UNSAFE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const DEFAULT_TIMEOUT_MS = 20000;

export class ApiError extends Error {
  constructor({ code, message, status, details, requestId }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }

  /** True when retrying the same request might succeed. */
  get isTransient() {
    return this.code === 'NETWORK' || this.code === 'TIMEOUT' || this.status >= 500;
  }
}

function readCookie(name) {
  const prefix = `${name}=`;
  for (const part of document.cookie.split('; ')) {
    if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
  }
  return null;
}

function buildUrl(path, query) {
  const url = new URL(`/api${path.startsWith('/') ? path : `/${path}`}`, location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

export async function request(
  path,
  { method = 'GET', body, query, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const upperMethod = method.toUpperCase();
  const headers = { Accept: 'application/json' };

  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (UNSAFE_METHODS.has(upperMethod)) {
    const token = readCookie(CSRF_COOKIE);
    if (token) headers[CSRF_HEADER] = token;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(buildUrl(path, query), {
      method: upperMethod,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    throw new ApiError({
      code: timedOut ? 'TIMEOUT' : 'NETWORK',
      status: 0,
      message: timedOut
        ? 'The request took too long. Check your connection and try again.'
        : 'Could not reach the server. Check your connection and try again.',
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 204) return null;

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Fall through: a non-JSON body from a proxy or an edge error page.
  }

  return finish(response, payload);
}

/** Shared tail of a request: turn a non-2xx into an ApiError, else return the body. */
function finish(response, payload) {
  if (!response.ok) {
    const error = payload?.error ?? {};
    const apiError = new ApiError({
      code: error.code ?? 'INTERNAL',
      message: error.message ?? 'Something went wrong. Please try again.',
      status: response.status,
      details: error.details,
      requestId: error.requestId,
    });

    if (response.status === 401) {
      document.dispatchEvent(new CustomEvent('cma:unauthenticated', { detail: { apiError } }));
    }

    throw apiError;
  }

  return payload;
}

/**
 * Fetch a file the server returns as a download (a report CSV, today).
 *
 * A GET, so no CSRF token is needed; the session cookie rides along as usual. On
 * failure the JSON error envelope is parsed into an ApiError exactly as a normal
 * request, so a "too many rows" 409 surfaces with its message rather than saving
 * a file full of error JSON. The server chooses the filename via
 * Content-Disposition; a fallback is used only if the header is somehow absent.
 */
export async function download(path, { query, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(buildUrl(path, query), {
      method: 'GET',
      headers: { Accept: 'text/csv' },
      credentials: 'same-origin',
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    throw new ApiError({
      code: timedOut ? 'TIMEOUT' : 'NETWORK',
      status: 0,
      message: timedOut
        ? 'The download took too long. Try a narrower date range.'
        : 'Could not reach the server. Check your connection and try again.',
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // A non-JSON error body; finish() falls back to a generic message.
    }
    finish(response, payload);
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? 'report.csv';
  return { blob: await response.blob(), filename };
}

export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
  delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
  download: (path, options) => download(path, options),
};
