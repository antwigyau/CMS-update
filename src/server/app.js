/**
 * The application entrypoint, independent of any host.
 *
 * `handleRequest(Request) -> Response` is a pure function of the request plus
 * configuration, which is what lets the same code run behind three very
 * different hosts without a compatibility layer:
 *
 *   api/index.js            Vercel Function (production)
 *   scripts/dev-server.mjs  node:http (local development)
 *   tests/**                called directly, no server, no ports
 *
 * That third one is the reason it is shaped this way: the test suite exercises
 * the real routing, guard, and error paths rather than a mock of them.
 */

import { createIdentityLoader } from '../auth/identity.js';
import { createSupabaseAuthProvider } from '../auth/provider.js';
import { createSessionResolver } from '../auth/session.js';
import { config } from '../config/env.js';
import { badRequest, internalError, notFound, payloadTooLarge } from '../lib/errors.js';
import { toErrorResponse } from '../lib/http.js';
import { createLogger } from '../lib/logger.js';
import { createGuards } from './middleware/auth.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { createRouter } from './router.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerAttendanceRoutes } from './routes/attendance.routes.js';
import { registerEventRoutes } from './routes/events.routes.js';
import { registerFamilyRoutes } from './routes/families.routes.js';
import { registerFinanceRoutes } from './routes/finance.routes.js';
import { registerHealthRoutes } from './routes/health.routes.js';
import { registerMemberRoutes } from './routes/members.routes.js';
import { registerMinistryRoutes } from './routes/ministries.routes.js';
import { registerReportRoutes } from './routes/reports.routes.js';
import { registerAuditRoutes } from './routes/audit.routes.js';
import { registerGiftRoutes } from './routes/gifts.routes.js';
import { registerNotificationsRoutes } from './routes/notifications.routes.js';
import { registerRolesRoutes } from './routes/roles.routes.js';
import { registerSettingsRoutes } from './routes/settings.routes.js';
import { registerUsersRoutes } from './routes/users.routes.js';
import { createAttendanceService } from '../services/attendance.service.js';
import { createEventsService } from '../services/events.service.js';
import { createFamiliesService } from '../services/families.service.js';
import { createFinanceService } from '../services/finance.service.js';
import { createMembersService } from '../services/members.service.js';
import { createMinistriesService } from '../services/ministries.service.js';
import { createReportsService } from '../services/reports.service.js';
import { createAuditService } from '../services/audit.service.js';
import { createStorageService } from '../services/storage.service.js';
import { createGiftsService } from '../services/gifts.service.js';
import { createNotificationsService } from '../services/notifications.service.js';
import { createRolesService } from '../services/roles.service.js';
import { createSettingsService } from '../services/settings.service.js';
import { createUsersService } from '../services/users.service.js';

/** Vercel caps request bodies well above this; we cap lower on purpose. */
const MAX_BODY_BYTES = 128 * 1024;

/** The filename our vercel.json rewrite targets. */
const FUNCTION_ENTRYPOINTS = new Set(['/index', '/index.js']);

/**
 * Work out which application route a request is asking for.
 *
 * Production traffic arrives via `vercel.json`:
 *   { "source": "/api/(.*)", "destination": "/api/index?path=$1" }
 *
 * The pathname is expected to survive that rewrite, but the `?path=` capture is
 * carried as a belt-and-braces fallback so routing cannot silently break if it
 * does not. The pathname is preferred, which also means a client cannot spoof a
 * route by appending its own `?path=`.
 */
export function resolvePath(requestUrl) {
  const url = new URL(requestUrl);
  let pathname = url.pathname;

  if (pathname === '/api') pathname = '/';
  else if (pathname.startsWith('/api/')) pathname = pathname.slice('/api'.length);

  if (FUNCTION_ENTRYPOINTS.has(pathname)) {
    const fromQuery = url.searchParams.get('path');
    pathname = fromQuery ? `/${fromQuery.replace(/^\/+/, '')}` : pathname;
  }

  // Trailing slashes are noise: /members/ and /members are the same endpoint.
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export function getClientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? null;
}

/**
 * Build the application's dependency graph and route table.
 *
 * Everything here is constructed lazily with respect to Supabase: the provider
 * and identity loader create their clients per call, so a cold start with no
 * Supabase credentials still succeeds and `/api/health` still answers. The first
 * request that actually needs the database is where a missing credential
 * surfaces — as a clear configuration error, not a crash at import.
 *
 * Every dependency is overridable, which is what lets the test suite exercise
 * the real cookie, CSRF, rate-limit, and guard code against a fake GoTrue.
 */
export function buildRouter({
  cfg = config,
  provider = createSupabaseAuthProvider(),
  loadIdentity = createIdentityLoader(),
  rateLimiter = createRateLimiter(),
  sessionResolver,
  members = createMembersService(),
  families = createFamiliesService(),
  ministries = createMinistriesService(),
  attendance = createAttendanceService(),
  events = createEventsService(),
  finance = createFinanceService(),
  reports = createReportsService(),
  audit = createAuditService(),
  storage = createStorageService(),
  gifts = createGiftsService(),
  notifications = createNotificationsService(),
  roles = createRolesService(),
  settings = createSettingsService(),
  users = createUsersService(),
} = {}) {
  const resolver = sessionResolver ?? createSessionResolver({ provider, loadIdentity, cfg });
  const guards = createGuards({ sessionResolver: resolver, cfg });

  const router = createRouter({ guards });

  registerHealthRoutes(router);
  registerAuthRoutes(router, {
    provider,
    sessionResolver: resolver,
    rateLimiter,
    loadIdentity,
    cfg,
  });
  registerMemberRoutes(router, { members, audit, storage });
  registerFamilyRoutes(router, { families, audit });
  registerMinistryRoutes(router, { ministries, audit });
  registerAttendanceRoutes(router, { attendance, audit });
  registerEventRoutes(router, { events, audit });
  registerFinanceRoutes(router, { finance, audit });
  registerReportRoutes(router, { reports });
  registerAuditRoutes(router, { audit });
  registerGiftRoutes(router, { gifts, audit });
  registerRolesRoutes(router, { roles, audit });
  registerSettingsRoutes(router, { settings, audit });
  registerUsersRoutes(router, { users, audit });
  registerNotificationsRoutes(router, { notifications, audit });

  return router;
}

// Built once per cold start. A registration error throws here, during import,
// which is exactly when we want to hear about it.
const router = buildRouter();

export function getRouteTable() {
  return router.list();
}

async function readJsonBody(request) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw badRequest('Expected Content-Type: application/json.');
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) {
    throw payloadTooLarge('Request body is too large.');
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw payloadTooLarge('Request body is too large.');
  }
  if (raw.trim() === '') {
    throw badRequest('Request body is empty.');
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest('Request body is not valid JSON.');
  }
}

/**
 * @param {Request} request
 * @param {object} [options]
 * @param {(line: string) => void} [options.sink]  Log sink, injected by tests.
 * @param {object} [options.router]  Route table override, injected by tests.
 */
export async function handleRequest(request, { sink, router: routerOverride } = {}) {
  const activeRouter = routerOverride ?? router;

  // Vercel's own request id, when present, so our logs correlate with the
  // platform's. Otherwise generate one.
  const requestId = request.headers.get('x-vercel-id') ?? crypto.randomUUID();
  const baseLogger = createLogger({ requestId }, { level: config.logLevel, sink });
  const startedAt = performance.now();
  const pathname = resolvePath(request.url);

  let logger = baseLogger;
  let response;
  try {
    const matched = activeRouter.match(request.method, pathname);
    if (!matched) throw notFound('This endpoint does not exist.');

    const url = new URL(request.url);
    const context = {
      request,
      params: matched.params,
      query: url.searchParams,
      pathname,
      method: request.method.toUpperCase(),
      requestId,
      logger: baseLogger,
      ip: getClientIp(request),
      json: () => readJsonBody(request),
    };

    let guardResponse = null;
    for (const guard of matched.route.guards) {
      const result = await guard(context);
      if (result instanceof Response) {
        guardResponse = result;
        break;
      }
    }

    // requireSession replaces context.logger with a child carrying the user id;
    // pick it up so the summary line below is attributed too.
    logger = context.logger;

    response = guardResponse ?? (await matched.route.handler(context));

    if (!(response instanceof Response)) {
      throw internalError(
        `Handler for ${matched.route.method} ${matched.route.pattern} did not return a Response.`,
      );
    }
  } catch (thrown) {
    response = toErrorResponse(thrown, { requestId, logger });
  }

  logger.info('request', {
    method: request.method,
    path: pathname,
    status: response.status,
    durationMs: Math.round(performance.now() - startedAt),
    ip: getClientIp(request),
  });

  // A HEAD response must not carry a body.
  if (request.method.toUpperCase() === 'HEAD') {
    return new Response(null, { status: response.status, headers: response.headers });
  }
  return response;
}
