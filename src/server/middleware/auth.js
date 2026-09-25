/**
 * Route guards.
 *
 * `createGuards()` returns the `{ requireSession, requirePermission }` pair the
 * router demands before it will register a permissioned route. Until Phase 3
 * there was no such pair, so the router refused any protected route — which is
 * what made "we forgot to wire up authorization" impossible rather than silent.
 *
 * Two decisions worth knowing:
 *
 * 1. **`requireSession` also enforces CSRF** on state-changing methods. Making it
 *    a separate guard would mean every future route had to remember to include
 *    it, and the failure mode of forgetting is invisible. Coupling them means an
 *    authenticated mutation is CSRF-checked by construction.
 *
 * 2. **`requirePermission` without a branch asks "anywhere at all?"** A route
 *    whose resource belongs to a branch must ALSO check that branch in its
 *    handler, via `context.can(permission, branchId)`. The guard cannot do it:
 *    at guard time the row has not been read, so its branch is unknown. RLS is
 *    the backstop that makes this safe rather than merely conventional — a
 *    handler that forgets still cannot read another branch's rows.
 */

import { assertCsrf } from '../../auth/csrf.js';
import { forbidden } from '../../lib/errors.js';

/**
 * @param {object} dependencies
 * @param {object} dependencies.sessionResolver  From createSessionResolver().
 * @param {object} [dependencies.cfg]
 */
export function createGuards({ sessionResolver, cfg }) {
  async function requireSession(context) {
    assertCsrf(context.request, { cfg });

    const session = await sessionResolver.requireSession(context.request);

    context.session = session;
    context.user = { id: session.userId, fullName: session.fullName };
    context.can = (permission, branchId) => session.permissions.can(permission, branchId);
    context.leadsMinistry = (ministryId) => (session.ledMinistryIds ?? []).includes(ministryId);

    // Every log line for this request now carries who made it.
    context.logger = context.logger.child({ userId: session.userId });
  }

  function requirePermission(permission) {
    return function permissionGuard(context) {
      if (!context.session) {
        // Unreachable through the router, which always puts requireSession
        // first. Guards against a hand-assembled chain getting it wrong.
        throw forbidden('This endpoint requires a session.');
      }

      if (!context.can(permission)) {
        context.logger.warn('permission denied', { permission });
        throw forbidden('You do not have permission to do that.');
      }
    };
  }

  /**
   * For routes a ministry leader may reach without holding the permission
   * branch-wide.
   *
   * The guard asks the loose question — "do they hold this, or do they lead any
   * ministry at all?" — because the target ministry is not known until the
   * handler has read the request. The handler then calls
   * `assertMinistryAuthority` with the specific ministry, and RLS refuses the
   * write independently if both checks were somehow wrong.
   *
   * Without this, a ministry leader would be refused at the API layer before RLS
   * ever saw the request, and their computed authority (ADR-020) would be
   * unreachable through the API.
   */
  function requirePermissionOrLeadership(permission) {
    return function leadershipGuard(context) {
      if (!context.session) throw forbidden('This endpoint requires a session.');

      const leadsSomething = (context.session.ledMinistryIds ?? []).length > 0;
      if (!context.can(permission) && !leadsSomething) {
        context.logger.warn('permission denied', { permission });
        throw forbidden('You do not have permission to do that.');
      }
    };
  }

  return { requireSession, requirePermission, requirePermissionOrLeadership };
}

/**
 * Assert a branch-scoped permission from inside a handler, once the target
 * branch is known. The message never names the branch: telling someone which
 * branch they were refused confirms it exists.
 */
export function assertPermissionIn(context, permission, branchId) {
  if (!context.can(permission, branchId)) {
    context.logger.warn('branch permission denied', { permission });
    throw forbidden('You do not have permission to do that.');
  }
}

/**
 * Assert authority over one ministry: the branch-scoped permission, or
 * leadership of that specific ministry.
 *
 * This is the API-layer mirror of the `permission OR is_ministry_leader(id)`
 * shape the RLS policies use. Both layers exist on purpose — this one produces a
 * clear 403, and RLS is the one that cannot be bypassed by a bug here.
 */
export function assertMinistryAuthority(context, permission, { ministryId, branchId }) {
  if (context.can(permission, branchId)) return;
  if (context.leadsMinistry(ministryId)) return;

  context.logger.warn('ministry authority denied', { permission, ministryId });
  throw forbidden('You do not have permission to do that.');
}
