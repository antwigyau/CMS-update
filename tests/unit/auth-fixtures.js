/**
 * A fake GoTrue, so the authentication surface can be tested for real.
 *
 * Everything except the provider is the production code: cookie construction and
 * parsing, CSRF, the rate limiter, the session resolver, the guards, the route
 * handlers, validation, and error mapping. Only the four calls that would leave
 * this machine are replaced.
 *
 * What that leaves unverified is precisely the GoTrue round trip itself â€” whether
 * Supabase accepts our sign-in arguments, and whether the recovery email carries
 * the token hash we expect. Both need a real project. Everything around them is
 * exercised here.
 */

import { createPermissionSet } from '../../src/auth/identity.js';

/**
 * The seeded branch's id. A real UUID, because `branchId` is validated as one —
 * an invented string like 'branch-main' would make every create request a 422 and
 * the tests would be exercising validation rather than the thing under test.
 */
export const BRANCH_MAIN = '3f1c9a44-2b7e-4d1a-9c8f-0a1b2c3d4e5f';

/** The choir, used by the ministry-leadership fixtures. */
export const MINISTRY_CHOIR = '5a2b8c66-4d9f-4e2b-8a7c-1b2c3d4e5f60';

const base64url = (value) =>
  Buffer.from(JSON.stringify(value)).toString('base64url').replaceAll('=', '');

/**
 * Mint a token whose `exp` claim the session logic can read.
 *
 * The signature is not a real signature. It does not need to be: the server
 * decodes `exp` only to schedule refreshes, and Supabase â€” not us â€” verifies the
 * token on every query. `tests/unit/session.test.js` asserts that property.
 */
export function mintToken({ sub = 'user-1', expiresInSeconds = 3600 } = {}) {
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({
    sub,
    role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  });
  return `${header}.${payload}.not-a-real-signature`;
}

/**
 * A provider that behaves like GoTrue for a fixed set of accounts.
 *
 * `calls` records every interaction, so tests can assert that logout really
 * revoked the token and that a failed login did not.
 */
export function createFakeProvider({
  accounts = {},
  failRefresh = false,
  failSignOut = false,
} = {}) {
  const calls = { signIn: [], signOut: [], refresh: [], resetRequested: [], passwordUpdated: [] };
  let refreshCounter = 0;

  const provider = {
    async signInWithPassword({ email, password }) {
      calls.signIn.push({ email });
      const account = accounts[email];

      // One message for both cases, exactly as the real provider wrapper does.
      if (!account || account.password !== password) {
        const { unauthenticated } = await import('../../src/lib/errors.js');
        throw unauthenticated('That email address and password combination is not recognised.');
      }

      return {
        accessToken: mintToken({ sub: account.id }),
        refreshToken: `refresh-${account.id}-0`,
        expiresIn: 3600,
        user: { id: account.id, email },
      };
    },

    async refreshSession(refreshToken) {
      calls.refresh.push(refreshToken);
      if (failRefresh) {
        const { unauthenticated } = await import('../../src/lib/errors.js');
        throw unauthenticated('Your session has expired. Please sign in again.');
      }

      const sub = /^refresh-(.+)-\d+$/.exec(refreshToken)?.[1];
      if (!sub) {
        const { unauthenticated } = await import('../../src/lib/errors.js');
        throw unauthenticated('Your session has expired. Please sign in again.');
      }

      refreshCounter += 1;
      const email = Object.keys(accounts).find((key) => accounts[key].id === sub);
      return {
        accessToken: mintToken({ sub }),
        refreshToken: `refresh-${sub}-${refreshCounter}`,
        expiresIn: 3600,
        user: { id: sub, email },
      };
    },

    async signOut(accessToken) {
      calls.signOut.push(accessToken);
      if (failSignOut) {
        throw new Error('gotrue unavailable');
      }
    },

    async requestPasswordReset({ email, redirectTo }) {
      calls.resetRequested.push({ email, redirectTo });
    },

    async verifyRecoveryToken(tokenHash) {
      if (tokenHash !== 'valid-recovery-token-hash') {
        const { unauthenticated } = await import('../../src/lib/errors.js');
        throw unauthenticated('That password reset link has expired or has already been used.');
      }
      return {
        accessToken: mintToken({ sub: 'user-1' }),
        refreshToken: 'refresh-user-1-0',
        expiresIn: 3600,
        user: { id: 'user-1', email: 'secretary@church.test' },
      };
    },

    async updatePassword({ accessToken, password }) {
      calls.passwordUpdated.push({ accessToken, passwordLength: password.length });
    },

    async getUser() {
      return null;
    },
  };

  return { provider, calls };
}

/**
 * An identity loader backed by a plain object rather than the database.
 *
 * The `isActive` flag matters: it is how the tests prove that a deactivated
 * account is refused at the API layer as well as by RLS.
 */
export function createFakeIdentityLoader(profiles) {
  return async function loadIdentity(accessToken) {
    const sub = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()).sub;
    const profile = profiles[sub];

    const { unauthenticated } = await import('../../src/lib/errors.js');
    if (!profile) {
      throw unauthenticated('Your account is not set up. Contact an administrator.');
    }
    if (!profile.isActive) {
      throw unauthenticated('This account has been deactivated.');
    }

    return {
      userId: sub,
      fullName: profile.fullName,
      defaultBranchId: profile.defaultBranchId ?? null,
      isActive: true,
      permissions: createPermissionSet(profile.grants ?? []),
      // Computed from ministry_members in production; a plain list here.
      ledMinistryIds: profile.ledMinistryIds ?? [],
      // Public settings, read from the settings table in production; a plain
      // object here. Defaults to the seeded values so the session payload carries
      // the church name and currency.
      settings: profile.settings ?? { 'church.name': 'Church Manager', 'finance.currency': 'GHS' },
    };
  };
}

/** The standard cast used across the auth tests. */
export const FIXTURES = Object.freeze({
  accounts: {
    'secretary@church.test': { id: 'user-1', password: 'correct-horse-battery' },
    'usher@church.test': { id: 'user-2', password: 'correct-horse-battery' },
    'suspended@church.test': { id: 'user-3', password: 'correct-horse-battery' },
  },
  profiles: {
    'user-1': {
      fullName: 'Ama Secretary',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'members.view', branchId: BRANCH_MAIN },
        { permissionKey: 'members.create', branchId: BRANCH_MAIN },
        { permissionKey: 'members.update', branchId: BRANCH_MAIN },
        { permissionKey: 'families.view', branchId: BRANCH_MAIN },
        { permissionKey: 'families.create', branchId: BRANCH_MAIN },
        { permissionKey: 'families.update', branchId: BRANCH_MAIN },
        { permissionKey: 'settings.view', branchId: null },
      ],
    },
    'user-2': {
      fullName: 'Kojo Usher',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [{ permissionKey: 'members.view_directory', branchId: BRANCH_MAIN }],
    },
    'user-3': { fullName: 'Suspended Person', isActive: false, grants: [] },
    // A records administrator: everything the secretary has, plus the two
    // deletion permissions. The fixture for soft-delete, restore, and household
    // deletion.
    'user-4': {
      fullName: 'Yaa Registrar',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'members.view', branchId: BRANCH_MAIN },
        { permissionKey: 'members.create', branchId: BRANCH_MAIN },
        { permissionKey: 'members.update', branchId: BRANCH_MAIN },
        { permissionKey: 'members.delete', branchId: BRANCH_MAIN },
        { permissionKey: 'members.photo.manage', branchId: BRANCH_MAIN },
        { permissionKey: 'families.view', branchId: BRANCH_MAIN },
        { permissionKey: 'families.create', branchId: BRANCH_MAIN },
        { permissionKey: 'families.update', branchId: BRANCH_MAIN },
        { permissionKey: 'families.delete', branchId: BRANCH_MAIN },
      ],
    },

    /**
     * A ministry leader. Note what they do NOT hold: no `ministries.update`, no
     * `ministries.members.manage`, no `members.view`. Their authority over the
     * choir is computed from `ministry_members` and appears here as
     * `ledMinistryIds` — the same shape `app.my_led_ministry_ids()` returns.
     *
     * This fixture is the API-layer counterpart of the RLS test that asserts the
     * seeded role holds no branch-wide write grants (ADR-020).
     */
    'user-6': {
      fullName: 'Esi Choir Leader',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      ledMinistryIds: [MINISTRY_CHOIR],
      grants: [
        { permissionKey: 'members.view_directory', branchId: BRANCH_MAIN },
        { permissionKey: 'ministries.view', branchId: BRANCH_MAIN },
        { permissionKey: 'events.view', branchId: BRANCH_MAIN },
        { permissionKey: 'reports.ministry.view', branchId: BRANCH_MAIN },
      ],
    },

    /** A ministry administrator: the branch-wide grants a leader lacks. */
    'user-7': {
      fullName: 'Kwesi Coordinator',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'ministries.view', branchId: BRANCH_MAIN },
        { permissionKey: 'ministries.create', branchId: BRANCH_MAIN },
        { permissionKey: 'ministries.update', branchId: BRANCH_MAIN },
        { permissionKey: 'ministries.delete', branchId: BRANCH_MAIN },
        { permissionKey: 'ministries.members.manage', branchId: BRANCH_MAIN },
      ],
    },

    /**
     * An usher. Can open a session and write the register, but cannot close one,
     * correct an entry, or delete anything — the narrowest attendance role, and
     * the one that proves the permissions are genuinely separate.
     */
    'user-8': {
      fullName: 'Kojo Usher',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'members.view_directory', branchId: BRANCH_MAIN },
        { permissionKey: 'attendance.view', branchId: BRANCH_MAIN },
        { permissionKey: 'attendance.session.create', branchId: BRANCH_MAIN },
        { permissionKey: 'attendance.record', branchId: BRANCH_MAIN },
      ],
    },

    /** An attendance administrator: everything, including close and delete. */
    'user-9': {
      fullName: 'Adwoa Registrar',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'members.view', branchId: BRANCH_MAIN },
        { permissionKey: 'attendance.view', branchId: BRANCH_MAIN },
        { permissionKey: 'attendance.session.create', branchId: BRANCH_MAIN },
        { permissionKey: 'attendance.session.close', branchId: BRANCH_MAIN },
        { permissionKey: 'attendance.record', branchId: BRANCH_MAIN },
        { permissionKey: 'attendance.update', branchId: BRANCH_MAIN },
        { permissionKey: 'attendance.delete', branchId: BRANCH_MAIN },
      ],
    },

    /**
     * An events editor: may create and correct an event, but not announce it.
     * `events.publish` is deliberately absent — the split is the point.
     */
    'user-10': {
      fullName: 'Efua Media',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'members.view_directory', branchId: BRANCH_MAIN },
        { permissionKey: 'events.view', branchId: BRANCH_MAIN },
        { permissionKey: 'events.create', branchId: BRANCH_MAIN },
        { permissionKey: 'events.update', branchId: BRANCH_MAIN },
      ],
    },

    /** An events administrator: publish, delete, and manage registrations too. */
    'user-11': {
      fullName: 'Nana Coordinator',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'events.view', branchId: BRANCH_MAIN },
        { permissionKey: 'events.create', branchId: BRANCH_MAIN },
        { permissionKey: 'events.update', branchId: BRANCH_MAIN },
        { permissionKey: 'events.publish', branchId: BRANCH_MAIN },
        { permissionKey: 'events.delete', branchId: BRANCH_MAIN },
        { permissionKey: 'events.attendance.manage', branchId: BRANCH_MAIN },
      ],
    },

    /**
     * A finance officer: records, edits, and submits transactions — but holds no
     * approve/reject/void. The record-and-submit half of the two-signature rule
     * (D6). This is the fixture that proves submit and approve are genuinely
     * separate permissions.
     */
    'user-12': {
      fullName: 'Abena Treasurer',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'members.view_directory', branchId: BRANCH_MAIN },
        { permissionKey: 'finance.view', branchId: BRANCH_MAIN },
        { permissionKey: 'finance.create', branchId: BRANCH_MAIN },
        { permissionKey: 'finance.update', branchId: BRANCH_MAIN },
        { permissionKey: 'finance.submit', branchId: BRANCH_MAIN },
        { permissionKey: 'finance.export', branchId: BRANCH_MAIN },
        { permissionKey: 'finance.categories.manage', branchId: BRANCH_MAIN },
      ],
    },

    /**
     * A finance approver (senior-pastor-shaped): approves, rejects, and voids —
     * but does not record or submit. The other half of the two-signature rule.
     * A caller who submitted a transaction is still refused approval of it by the
     * self-approval guard, even holding finance.approve.
     */
    'user-13': {
      fullName: 'Kofi Pastor',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'finance.view', branchId: BRANCH_MAIN },
        { permissionKey: 'finance.approve', branchId: BRANCH_MAIN },
        { permissionKey: 'finance.reject', branchId: BRANCH_MAIN },
        { permissionKey: 'finance.void', branchId: BRANCH_MAIN },
      ],
    },

    /**
     * A reporting reader (senior-pastor / elder shaped): holds every `reports.*`
     * view permission and nothing else. The fixture that proves a report is gated
     * on its own permission, distinct from the feature's operational permissions —
     * this user can read the finance report but cannot record a transaction.
     */
    'user-14': {
      fullName: 'Adjoa Overseer',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'reports.members.view', branchId: BRANCH_MAIN },
        { permissionKey: 'reports.attendance.view', branchId: BRANCH_MAIN },
        { permissionKey: 'reports.ministry.view', branchId: BRANCH_MAIN },
        { permissionKey: 'reports.event.view', branchId: BRANCH_MAIN },
        { permissionKey: 'reports.finance.view', branchId: BRANCH_MAIN },
      ],
    },

    /** An auditor: may read the audit trail, and holds nothing else. */
    'user-15': {
      fullName: 'Yaw Auditor',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [{ permissionKey: 'audit.view', branchId: null }],
    },

    /**
     * A gifts administrator: edits the shared spiritual-gift lookup
     * (`settings.manage`) and may attach gifts to members (`members.view`/`update`).
     * The fixture that proves editing the lookup and attaching to a member are two
     * different permissions.
     */
    'user-16': {
      fullName: 'Efua Administrator',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'members.view', branchId: BRANCH_MAIN },
        { permissionKey: 'members.update', branchId: BRANCH_MAIN },
        { permissionKey: 'settings.manage', branchId: null },
      ],
    },

    /**
     * A user administrator: the full account-management set, all global (branch id
     * null), exactly as the seed grants `users.*`. Invites, edits profiles, toggles
     * activation, and manages role grants. The self-service guards still refuse this
     * user's attempts to change their own activation or grants.
     */
    'user-17': {
      fullName: 'Ama Administrator',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'users.view', branchId: null },
        { permissionKey: 'users.invite', branchId: null },
        { permissionKey: 'users.update', branchId: null },
        { permissionKey: 'users.deactivate', branchId: null },
        { permissionKey: 'users.roles.manage', branchId: null },
      ],
    },

    /**
     * A read-only user viewer (senior-pastor / secretary shaped): holds `users.view`
     * and nothing else. The fixture that proves viewing is a separate permission from
     * inviting, editing, activating, and granting roles.
     */
    'user-18': {
      fullName: 'Kwame Observer',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [{ permissionKey: 'users.view', branchId: null }],
    },

    /**
     * A role administrator: holds `roles.manage` (global, branch id null — the way
     * the seed grants it) and one ordinary permission, `members.view`. The second
     * grant is what lets the escalation-guard tests prove both branches: adding
     * `members.view` to a role succeeds because this admin holds it, while adding a
     * permission they do not hold is refused. `roles.manage` is the only permission
     * that gates the role-admin routes; no other profile carries it.
     */
    'user-19': {
      fullName: 'Selorm Role Admin',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'roles.manage', branchId: null },
        { permissionKey: 'members.view', branchId: BRANCH_MAIN },
      ],
    },

    /**
     * A notification publisher (senior-pastor / secretary shaped): holds
     * `notifications.create` and `notifications.view`, both global (branch id
     * null, the way the seed grants them), plus `users.view`. That last grant is
     * not incidental — `resolveAudience` reads `profiles` and `user_roles` under
     * the user client, and `profiles_select_managed` / `user_roles_select_managed`
     * turn on `users.view`, so it is what lets a publish fan out to recipients.
     */
    'user-20': {
      fullName: 'Delphine Publisher',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [
        { permissionKey: 'notifications.create', branchId: null },
        { permissionKey: 'notifications.view', branchId: null },
        { permissionKey: 'users.view', branchId: null },
      ],
    },

    /**
     * An ordinary recipient: holds `notifications.view` and nothing else. Proves
     * the inbox works without `notifications.create`, and stands in for the 403
     * sweep across the publisher routes. (A user with neither — e.g. `user-2` —
     * covers the inbox 403.)
     */
    'user-21': {
      fullName: 'Ekow Member',
      isActive: true,
      defaultBranchId: BRANCH_MAIN,
      grants: [{ permissionKey: 'notifications.view', branchId: null }],
    },
  },
});
