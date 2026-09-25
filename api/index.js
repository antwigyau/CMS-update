/**
 * Vercel Function adapter.
 *
 * All /api/* traffic is rewritten here by vercel.json, so this file is the only
 * serverless function in the project. That is deliberate: a frameworkless
 * project on Vercel's Hobby plan is capped at 12 functions per deployment, and
 * one warm instance sharing one bundle also means one place for middleware.
 *
 * Everything real lives in src/server/app.js. This file only adapts the host.
 */

import { assertDeployedConfig } from '../src/config/env.js';
import { handleRequest } from '../src/server/app.js';

// Cold-start assertion: a deployment without database credentials should fail
// here, loudly, in the build/boot logs — not on a user's first login attempt.
assertDeployedConfig();

export default {
  fetch(request) {
    return handleRequest(request);
  },
};
