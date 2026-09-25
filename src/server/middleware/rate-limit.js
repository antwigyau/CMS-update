/**
 * Sliding-window rate limiting for the authentication endpoints.
 *
 * **Known limitation, stated plainly:** this store is in-process. Vercel runs
 * several function instances, so an attacker distributing attempts across them
 * gets a multiple of the nominal limit. It is therefore a brake on casual
 * credential stuffing, not a defence against a determined distributed attack.
 *
 * Two things make that acceptable for the MVP rather than negligent:
 *
 *   * Supabase Auth applies its own limits underneath, which are global.
 *   * The store is an injectable interface. Phase 13 swaps in a Postgres-backed
 *     implementation with the same three methods, and nothing else changes.
 *
 * Limits are keyed on both IP and identifier, because the two attacks differ: one
 * password against many accounts, and many passwords against one account.
 */

import { rateLimited } from '../../lib/errors.js';

/** Bounded so a flood of distinct keys cannot grow the map without limit. */
const MAX_TRACKED_KEYS = 10_000;

export function createMemoryRateLimitStore() {
  /** @type {Map<string, number[]>} key -> ascending hit timestamps */
  const hits = new Map();

  function prune(key, windowMs, now) {
    const timestamps = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
    if (timestamps.length === 0) hits.delete(key);
    else hits.set(key, timestamps);
    return timestamps;
  }

  return {
    async count(key, windowMs, now = Date.now()) {
      return prune(key, windowMs, now).length;
    },

    async record(key, windowMs, now = Date.now()) {
      // Evict the oldest entries wholesale rather than tracking LRU: this is a
      // safety valve, and under normal load it never fires.
      if (hits.size >= MAX_TRACKED_KEYS && !hits.has(key)) {
        for (const existing of [...hits.keys()].slice(0, MAX_TRACKED_KEYS / 10)) {
          hits.delete(existing);
        }
      }

      const timestamps = prune(key, windowMs, now);
      timestamps.push(now);
      hits.set(key, timestamps);
      return timestamps.length;
    },

    async reset(key) {
      hits.delete(key);
    },
  };
}

/**
 * @param {object} [options]
 * @param {object} [options.store]
 * @param {() => number} [options.now]  Injected so tests need no timers.
 */
export function createRateLimiter({ store = createMemoryRateLimitStore(), now = Date.now } = {}) {
  /**
   * @param {object} rule
   * @param {string} rule.name        Namespace, so /login and /reset do not share a budget.
   * @param {string[]} rule.keys      Every dimension to limit on, e.g. [ip, email].
   * @param {number} rule.limit
   * @param {number} rule.windowMs
   * @param {string} [rule.message]
   */
  async function assertWithin({ name, keys, limit, windowMs, message }) {
    const present = keys.filter((key) => key !== null && key !== undefined && key !== '');
    const timestamp = now();

    for (const key of present) {
      const namespaced = `${name}:${key}`;
      const used = await store.count(namespaced, windowMs, timestamp);

      if (used >= limit) {
        throw rateLimited(
          message ?? 'Too many attempts. Please wait a few minutes and try again.',
          { details: { retryAfterSeconds: Math.ceil(windowMs / 1000) } },
        );
      }
    }

    // Recorded only once the check passes for every dimension, so a request
    // rejected on one key does not also consume budget on the others.
    for (const key of present) {
      await store.record(`${name}:${key}`, windowMs, timestamp);
    }
  }

  /** Called after a successful sign-in, so a legitimate user is not throttled. */
  async function clear({ name, keys }) {
    for (const key of keys) {
      if (key) await store.reset(`${name}:${key}`);
    }
  }

  return { assertWithin, clear };
}

/**
 * The rules. Deliberately generous enough not to obstruct a user who has
 * genuinely forgotten which password they used, and tight enough that guessing is
 * pointless.
 */
export const RATE_LIMITS = Object.freeze({
  login: { name: 'login', limit: 10, windowMs: 15 * 60 * 1000 },
  passwordForgot: { name: 'password-forgot', limit: 5, windowMs: 60 * 60 * 1000 },
  passwordReset: { name: 'password-reset', limit: 10, windowMs: 60 * 60 * 1000 },
});
