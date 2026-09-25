/**
 * Application version, reported by /api/health.
 *
 * Hardcoded rather than read from package.json, because the serverless bundle
 * does not reliably include package.json. `tests/unit/manifest.test.js` asserts
 * this constant matches package.json so the two cannot drift.
 */
export const APP_VERSION = '0.1.0';
export const APP_NAME = 'church-management-system';
