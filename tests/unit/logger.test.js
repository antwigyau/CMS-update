import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogger, redact } from '../../src/lib/logger.js';

function capture(options = {}) {
  const lines = [];
  const logger = createLogger(options.bindings ?? {}, {
    ...options,
    sink: (line) => lines.push(line),
  });
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line)) };
}

describe('redact', () => {
  it('masks anything whose key names a credential', () => {
    const input = {
      email: 'grace@example.com',
      password: 'hunter2',
      access_token: 'eyJhbGci',
      apiKey: 'sk-live-1',
      Authorization: 'Bearer abc',
      cookie: 'cma_at=…',
      SUPABASE_SERVICE_ROLE_KEY: 'secret',
    };

    const output = redact(input);
    assert.equal(output.email, 'grace@example.com');
    for (const key of [
      'password',
      'access_token',
      'apiKey',
      'Authorization',
      'cookie',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]) {
      assert.equal(output[key], '[redacted]', `${key} should have been redacted`);
    }
  });

  it('masks nested values too', () => {
    const output = redact({ session: { user: { email: 'a@b.c' }, refresh_token: 'rt' } });
    assert.equal(output.session.refresh_token, '[redacted]');
    assert.equal(output.session.user.email, 'a@b.c');
  });

  it('stops at a bounded depth so a cyclic-ish object cannot hang a request', () => {
    const deep = { a: { b: { c: { d: { e: 'too far' } } } } };
    assert.equal(redact(deep).a.b.c.d, '[truncated]');
  });

  it('caps long arrays', () => {
    assert.equal(redact(Array.from({ length: 50 }, (_, i) => i)).length, 20);
  });
});

describe('createLogger', () => {
  it('emits one JSON object per line with level, time, and message', () => {
    const { logger, parsed } = capture();
    logger.info('member created', { memberId: 'm-1' });

    const [line] = parsed();
    assert.equal(line.level, 'info');
    assert.equal(line.message, 'member created');
    assert.equal(line.memberId, 'm-1');
    assert.ok(!Number.isNaN(Date.parse(line.time)));
  });

  it('filters by level', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.debug('noise');
    logger.info('noise');
    logger.warn('kept');
    logger.error('kept');
    assert.equal(lines.length, 2);
  });

  it('attaches bindings to every line and lets children add more', () => {
    const { logger, parsed } = capture({ bindings: { requestId: 'r-1' } });
    logger.info('one');
    logger.child({ route: '/members' }).info('two');

    const [first, second] = parsed();
    assert.equal(first.requestId, 'r-1');
    assert.equal(second.requestId, 'r-1');
    assert.equal(second.route, '/members');
  });

  it('serialises an error with its stack for developers', () => {
    const { logger, parsed } = capture();
    const cause = new Error('underlying');
    const error = new Error('wrapper', { cause });
    error.code = 'DB_FAIL';

    logger.error('request failed', { error });

    const [line] = parsed();
    assert.equal(line.error.message, 'wrapper');
    assert.equal(line.error.code, 'DB_FAIL');
    assert.match(line.error.stack, /Error: wrapper/);
    assert.equal(line.error.cause.message, 'underlying');
  });

  it('redacts credentials that reach it inside log fields', () => {
    const { logger, parsed } = capture();
    logger.info('sign-in attempt', { email: 'a@b.c', password: 'hunter2' });

    const [line] = parsed();
    assert.equal(line.password, '[redacted]');
    assert.doesNotMatch(JSON.stringify(line), /hunter2/);
  });
});
