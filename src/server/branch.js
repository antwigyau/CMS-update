/**
 * Which branch a write applies to.
 *
 * Every branch-scoped create takes the branch from the payload if given, and
 * otherwise from the caller's default. That fallback is what keeps the
 * single-branch UI (decision D2) free of a branch picker while the schema stays
 * multi-branch — and it is the same rule for members, households, ministries, and
 * everything that follows, so it lives in one place.
 *
 * A caller with no default branch and no explicit choice is a configuration
 * problem, not a bad request in the usual sense, but 422 naming the field is the
 * most useful thing to return: an administrator can fix it by setting their
 * default branch.
 */

import { validationFailed } from '../lib/errors.js';

export function resolveBranchId(context, supplied) {
  const branchId = supplied ?? context.session.defaultBranchId;

  if (!branchId) {
    throw validationFailed('Choose a branch for this record.', {
      details: {
        fields: {
          branchId: 'This is required because your account has no default branch.',
        },
      },
    });
  }

  return branchId;
}
