/**
 * Structured logging.
 *
 * One JSON object per line, which is what Vercel's log pipeline indexes well.
 * Every line carries the requestId so a user-reported error message can be
 * traced to its cause without exposing anything to that user.
 *
 * Redaction is applied by key name, not by trusting callers to remember.
 */

const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

const SENSITIVE_KEY =
  /(password|passwd|token|secret|apikey|api_key|authorization|cookie|jwt|service_role)/i;
const REDACTED = '[redacted]';
const MAX_DEPTH = 4;

export function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}

function serialiseError(error) {
  if (!(error instanceof Error)) return redact(error);
  const out = { name: error.name, message: error.message, stack: error.stack };
  if (error.code) out.code = error.code;
  if (error.status) out.status = error.status;
  if (error.cause) out.cause = serialiseError(error.cause);
  return out;
}

/**
 * @param {object} [bindings]  Fields attached to every line, e.g. { requestId }.
 * @param {object} [options]
 * @param {string} [options.level]
 * @param {(line: string) => void} [options.sink]  Injectable for tests.
 */
export function createLogger(bindings = {}, { level = 'info', sink } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = sink ?? ((line) => process.stdout.write(`${line}\n`));

  function emit(levelName, message, fields = {}) {
    if (LEVELS[levelName] > threshold) return;

    const { error, ...rest } = fields;
    const line = {
      level: levelName,
      time: new Date().toISOString(),
      message,
      ...redact(bindings),
      ...redact(rest),
    };
    if (error !== undefined) line.error = serialiseError(error);

    write(JSON.stringify(line));
  }

  return {
    error: (message, fields) => emit('error', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    info: (message, fields) => emit('info', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
    child: (extra) => createLogger({ ...bindings, ...extra }, { level, sink }),
  };
}
