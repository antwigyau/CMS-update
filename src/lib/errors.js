/**
 * Application error types.
 *
 * Rule: the client only ever receives `code`, `message`, and `requestId`.
 * Anything diagnostic (SQL text, stack traces, upstream payloads) travels in
 * `cause` / `internal` and goes to the log only. See docs/SECURITY.md.
 */

export const ErrorCode = Object.freeze({
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  CSRF_FAILED: 'CSRF_FAILED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  CONFIG_ERROR: 'CONFIG_ERROR',
  INTERNAL: 'INTERNAL',
});

const DEFAULT_MESSAGES = {
  [ErrorCode.INTERNAL]: 'Something went wrong on our side. Please try again.',
  [ErrorCode.CONFIG_ERROR]: 'The service is misconfigured. Please contact an administrator.',
};

export class AppError extends Error {
  /**
   * @param {string} message      Safe to show a user.
   * @param {object} options
   * @param {string} options.code
   * @param {number} options.status
   * @param {object} [options.details]  Field-level validation detail (safe to expose).
   * @param {unknown} [options.cause]   Diagnostic only — never serialised to the client.
   * @param {boolean} [options.expose]  false => the client gets a generic message.
   */
  constructor(message, { code, status, details, cause, expose = true } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.code = code ?? ErrorCode.INTERNAL;
    this.status = status ?? 500;
    this.details = details;
    this.expose = expose;
  }

  /** The shape sent to the browser. Deliberately minimal. */
  toClientJson(requestId) {
    const message = this.expose
      ? this.message
      : (DEFAULT_MESSAGES[this.code] ?? DEFAULT_MESSAGES[ErrorCode.INTERNAL]);
    const error = { code: this.code, message };
    if (this.expose && this.details !== undefined) error.details = this.details;
    if (requestId) error.requestId = requestId;
    return { error };
  }
}

export function isAppError(value) {
  return value instanceof AppError;
}

const make =
  (code, status, defaults = {}) =>
  (message, options = {}) =>
    new AppError(message, { code, status, ...defaults, ...options });

export const validationFailed = make(ErrorCode.VALIDATION_FAILED, 422);
export const badRequest = make(ErrorCode.VALIDATION_FAILED, 400);
export const unauthenticated = make(ErrorCode.UNAUTHENTICATED, 401);
export const forbidden = make(ErrorCode.FORBIDDEN, 403);
export const notFound = make(ErrorCode.NOT_FOUND, 404);
export const methodNotAllowed = make(ErrorCode.METHOD_NOT_ALLOWED, 405);
export const conflict = make(ErrorCode.CONFLICT, 409);
export const csrfFailed = make(ErrorCode.CSRF_FAILED, 403);
export const payloadTooLarge = make(ErrorCode.PAYLOAD_TOO_LARGE, 413);
export const rateLimited = make(ErrorCode.RATE_LIMITED, 429);
export const notImplemented = make(ErrorCode.NOT_IMPLEMENTED, 501);

/** Never exposed: a config error would otherwise describe our own infrastructure. */
export const configError = make(ErrorCode.CONFIG_ERROR, 500, { expose: false });

/** Never exposed: the fallback for anything unexpected. */
export const internalError = make(ErrorCode.INTERNAL, 500, { expose: false });

/** Normalise anything thrown into an AppError without losing the original. */
export function toAppError(value) {
  if (isAppError(value)) return value;
  const message = value instanceof Error ? value.message : String(value);
  return internalError(message, { cause: value });
}
