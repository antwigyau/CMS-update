/**
 * Table-driven router.
 *
 * Replaces a web framework in about a hundred lines, and adds one thing a
 * framework would not give us: **deny by default**. A route must declare either
 * `public: true` or a `permission`. Forget both and registration throws at cold
 * start, so an unprotected endpoint cannot reach production by omission.
 *
 * If a route declares a permission but the router was built without the guards
 * that enforce it, registration also throws. That makes the "authorization
 * middleware exists but was not wired up" failure impossible rather than silent.
 */

import { methodNotAllowed } from '../lib/errors.js';

const PARAM_SEGMENT = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

function compile(pattern) {
  if (!pattern.startsWith('/')) {
    throw new Error(`Route pattern must start with "/": ${pattern}`);
  }

  const paramNames = [];
  const segments = pattern.split('/').slice(1);

  const source = segments
    .map((segment) => {
      const match = PARAM_SEGMENT.exec(segment);
      if (match) {
        paramNames.push(match[1]);
        return '/([^/]+)';
      }
      if (segment.includes(':')) {
        throw new Error(`Malformed parameter in route pattern: ${pattern}`);
      }
      return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('');

  return { regex: new RegExp(`^${source || '/'}$`), paramNames };
}

export function createRouter({ guards = {} } = {}) {
  const routes = [];

  function register(method, pattern, handler, options = {}) {
    const {
      public: isPublic = false,
      permission = null,
      // 'permission' (the default) requires the permission outright.
      // 'permissionOrLeadership' also admits a ministry leader, who then has the
      // specific ministry checked in the handler. See ADR-042.
      guard = 'permission',
      guards: extraGuards = [],
    } = options;

    if (!isPublic && !permission) {
      throw new Error(
        `Route ${method} ${pattern} declares neither "public: true" nor a "permission". ` +
          'Refusing to register an endpoint with no access decision.',
      );
    }
    if (isPublic && permission) {
      throw new Error(
        `Route ${method} ${pattern} is both public and permission-guarded — pick one.`,
      );
    }
    if (permission && (!guards.requireSession || !guards.requirePermission)) {
      throw new Error(
        `Route ${method} ${pattern} requires permission "${permission}" but the router was built ` +
          'without session/permission guards. Wire them in before registering protected routes.',
      );
    }
    if (permission && guard === 'permissionOrLeadership' && !guards.requirePermissionOrLeadership) {
      throw new Error(
        `Route ${method} ${pattern} asks for the leadership guard, which the router was not given.`,
      );
    }
    if (typeof handler !== 'function') {
      throw new Error(`Route ${method} ${pattern} has no handler function.`);
    }

    const { regex, paramNames } = compile(pattern);
    const permissionGuard =
      guard === 'permissionOrLeadership'
        ? guards.requirePermissionOrLeadership(permission)
        : guards.requirePermission?.(permission);

    const chain = permission
      ? [guards.requireSession, permissionGuard, ...extraGuards]
      : [...extraGuards];

    routes.push({
      method,
      pattern,
      regex,
      paramNames,
      handler,
      guards: chain,
      permission,
      guard: permission ? guard : null,
      isPublic,
    });
  }

  /**
   * @returns {{route: object, params: object}} on a hit.
   * @returns {null} when no route matches the path at all (404).
   * @throws  {AppError} 405 when the path matches but the method does not.
   */
  function match(method, pathname) {
    const normalisedMethod = method === 'HEAD' ? 'GET' : method.toUpperCase();
    const pathMatches = [];

    for (const route of routes) {
      const result = route.regex.exec(pathname);
      if (!result) continue;
      pathMatches.push(route);

      if (route.method === normalisedMethod) {
        const params = {};
        route.paramNames.forEach((name, index) => {
          params[name] = decodeURIComponent(result[index + 1]);
        });
        return { route, params };
      }
    }

    if (pathMatches.length === 0) return null;

    const allowed = [...new Set(pathMatches.map((route) => route.method))].sort();
    throw methodNotAllowed(`${method} is not supported for this endpoint.`, {
      details: { allowed },
    });
  }

  const verb = (method) => (pattern, handler, options) =>
    register(method, pattern, handler, options);

  return {
    get: verb('GET'),
    post: verb('POST'),
    patch: verb('PATCH'),
    put: verb('PUT'),
    delete: verb('DELETE'),
    match,
    /** Introspection for tests and for the route table in docs/API.md. */
    list: () =>
      routes.map(({ method, pattern, permission, guard, isPublic }) => ({
        method,
        pattern,
        permission,
        guard,
        isPublic,
      })),
  };
}
