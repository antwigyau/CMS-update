/**
 * Ministry endpoints.
 *
 *   GET    /api/ministries                          list, search, filter, paginate
 *   POST   /api/ministries                          create
 *   GET    /api/ministries/:id                      the ministry and its members
 *   PATCH  /api/ministries/:id                      edit
 *   DELETE /api/ministries/:id                      delete
 *   POST   /api/ministries/:id/members              add a member
 *   PATCH  /api/ministries/:id/members/:memberId    change role, or set left_on
 *
 * **This module is where a ministry leader's computed authority meets the API.**
 *
 * A leader holds no `ministries.update` or `ministries.members.manage` at branch
 * scope — deliberately, because granting either branch-wide would let the choir
 * leader manage the ushering team (ADR-020). Their authority over their OWN
 * ministry comes from `ministry_members`, and the RLS policies read
 * `permission OR is_ministry_leader(id)`.
 *
 * So the API guard cannot be a plain `requirePermission`: it would refuse the
 * leader before RLS ever saw the request. Instead these routes use the
 * `permissionOrLeadership` guard — which asks the loose question, because the
 * target ministry is not known at guard time — and each handler then calls
 * `assertMinistryAuthority` with the specific ministry. RLS refuses independently
 * if both were somehow wrong.
 */

import { created, noContent, ok } from '../../lib/http.js';
import { buildPageMeta, readPagination, readSort } from '../../lib/pagination.js';
import { validate } from '../../validation/index.js';
import {
  MINISTRY_SORTS,
  MINISTRY_STATUSES,
  ministryCreateSchema,
  ministryMemberAddSchema,
  ministryMemberUpdateSchema,
  ministryUpdateSchema,
  toMinistryListView,
  toMinistryMemberRow,
  toMinistryMemberView,
  toMinistryRow,
  toMinistryView,
} from '../../validation/ministries.schemas.js';
import { validationFailed } from '../../lib/errors.js';
import { assertMinistryAuthority, assertPermissionIn } from '../middleware/auth.js';
import { resolveBranchId } from '../branch.js';

/** Roles that carry authority over the ministry, matching app.my_led_ministry_ids(). */
const LEADERSHIP_ROLES = new Set(['leader', 'assistant_leader']);

function readStatus(query) {
  const value = query.get('status')?.trim();
  if (!value) return undefined;

  if (!MINISTRY_STATUSES.includes(value)) {
    throw validationFailed('That status filter is not recognised.', {
      details: { fields: { status: `Use one of: ${MINISTRY_STATUSES.join(', ')}.` } },
    });
  }
  return value;
}

export function registerMinistryRoutes(router, { ministries, audit }) {
  /* ---- list ------------------------------------------------------------- */

  async function list(context) {
    const pagination = readPagination(context.query);
    const sort = readSort(context.query.get('sort'), MINISTRY_SORTS, 'name');

    const { rows, total } = await ministries.list({
      accessToken: context.session.accessToken,
      branchId: context.query.get('branchId') || undefined,
      search: context.query.get('search')?.trim() || undefined,
      status: readStatus(context.query),
      sort,
      pagination,
    });

    return ok(
      rows.map((row) => ({
        ...toMinistryListView(row),
        // The frontend uses this to decide whether to offer leader controls. It
        // is a convenience: every endpoint checks again.
        youLead: context.leadsMinistry(row.id),
      })),
      {
        ...buildPageMeta({ page: pagination.page, pageSize: pagination.pageSize, total }),
        sort: sort.key,
        ascending: sort.ascending,
      },
    );
  }

  /* ---- create ----------------------------------------------------------- */

  async function create(context) {
    const payload = await context.json();
    const input = validate(ministryCreateSchema, {
      ...payload,
      branchId: resolveBranchId(context, payload?.branchId),
    });

    // Creating a ministry is not something leadership confers: you cannot lead a
    // ministry that does not exist yet.
    assertPermissionIn(context, 'ministries.create', input.branchId);

    const row = await ministries.create({
      accessToken: context.session.accessToken,
      row: toMinistryRow(input),
    });

    context.logger.info('ministry created', { ministryId: row.id, branchId: row.branch_id });
    await audit.record(context, {
      action: 'ministry.created',
      resourceType: 'ministry',
      resourceId: row.id,
      branchId: row.branch_id,
    });

    return created(toMinistryView(row), { location: `/api/ministries/${row.id}` });
  }

  /* ---- read ------------------------------------------------------------- */

  async function read(context) {
    const { accessToken } = context.session;
    const ministryId = context.params.id;
    const includeFormer = context.query.get('former') === '1';

    const ministry = await ministries.get({ accessToken, id: ministryId });
    const memberRows = await ministries.listMembers({
      accessToken,
      ministryId,
      includeFormer,
    });

    const members = memberRows.map(toMinistryMemberView);
    const current = members.filter((member) => member.isActive);

    return ok({
      ...toMinistryView(ministry),
      members,
      memberCount: current.length,
      leader: current.find((member) => member.roleInMinistry === 'leader') ?? null,
      assistantLeaders: current.filter((member) => member.roleInMinistry === 'assistant_leader'),
      youLead: context.leadsMinistry(ministryId),
    });
  }

  /* ---- update ----------------------------------------------------------- */

  async function update(context) {
    const input = validate(ministryUpdateSchema, await context.json());
    const ministryId = context.params.id;

    // Read first: this supplies the branch for the permission check, and 404s if
    // the caller may not see the ministry at all.
    const ministry = await ministries.get({
      accessToken: context.session.accessToken,
      id: ministryId,
    });

    assertMinistryAuthority(context, 'ministries.update', {
      ministryId,
      branchId: ministry.branch_id,
    });

    const row = await ministries.update({
      accessToken: context.session.accessToken,
      id: ministryId,
      patch: toMinistryRow(input),
    });

    const fields = Object.keys(input).sort();
    context.logger.info('ministry updated', { ministryId: row.id, fields });
    await audit.record(context, {
      action: 'ministry.updated',
      resourceType: 'ministry',
      resourceId: row.id,
      branchId: ministry.branch_id,
      changes: { fields },
    });

    return ok(toMinistryView(row));
  }

  async function remove(context) {
    // Deleting a ministry is not a leader's decision about their own ministry —
    // it removes the ministry's history from everyone. Branch permission only.
    const ministry = await ministries.get({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });

    assertPermissionIn(context, 'ministries.delete', ministry.branch_id);

    await ministries.remove({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });

    context.logger.info('ministry deleted', { ministryId: context.params.id });
    await audit.record(context, {
      action: 'ministry.deleted',
      resourceType: 'ministry',
      resourceId: context.params.id,
      branchId: ministry.branch_id,
    });
    return noContent();
  }

  /* ---- membership ------------------------------------------------------- */

  async function addMember(context) {
    const input = validate(ministryMemberAddSchema, await context.json());
    const ministryId = context.params.id;

    const ministry = await ministries.get({
      accessToken: context.session.accessToken,
      id: ministryId,
    });

    assertMinistryAuthority(context, 'ministries.members.manage', {
      ministryId,
      branchId: ministry.branch_id,
    });

    // Appointing a leader or assistant grants authority over the ministry, so a
    // leader may not do it: that is how a leader would otherwise expand the set
    // of people who can edit their ministry, or entrench themselves. It needs the
    // branch permission.
    if (LEADERSHIP_ROLES.has(input.roleInMinistry)) {
      assertPermissionIn(context, 'ministries.members.manage', ministry.branch_id);
    }

    const row = await ministries.addMember({
      accessToken: context.session.accessToken,
      ministryId,
      branchId: ministry.branch_id,
      row: toMinistryMemberRow(input),
    });

    context.logger.info('ministry member added', {
      ministryId,
      memberId: input.memberId,
      role: input.roleInMinistry,
    });
    await audit.record(context, {
      action: 'ministry.member_added',
      resourceType: 'ministry',
      resourceId: ministryId,
      branchId: ministry.branch_id,
      changes: { memberId: input.memberId, role: input.roleInMinistry },
    });

    return created(toMinistryMemberView(row));
  }

  async function updateMember(context) {
    const input = validate(ministryMemberUpdateSchema, await context.json());
    const ministryId = context.params.id;

    const ministry = await ministries.get({
      accessToken: context.session.accessToken,
      id: ministryId,
    });

    assertMinistryAuthority(context, 'ministries.members.manage', {
      ministryId,
      branchId: ministry.branch_id,
    });

    // Same rule as adding: promoting someone into a leadership role is a branch
    // decision, not a leader's.
    if (input.roleInMinistry && LEADERSHIP_ROLES.has(input.roleInMinistry)) {
      assertPermissionIn(context, 'ministries.members.manage', ministry.branch_id);
    }

    const row = await ministries.updateMember({
      accessToken: context.session.accessToken,
      ministryId,
      memberId: context.params.memberId,
      patch: toMinistryMemberRow(input),
    });

    const fields = Object.keys(input).sort();
    context.logger.info('ministry member updated', {
      ministryId,
      memberId: context.params.memberId,
      fields,
    });
    await audit.record(context, {
      action: 'ministry.member_updated',
      resourceType: 'ministry',
      resourceId: ministryId,
      branchId: ministry.branch_id,
      changes: { memberId: context.params.memberId, fields },
    });

    return ok(toMinistryMemberView(row));
  }

  /* ---- registration ----------------------------------------------------- */

  router.get('/ministries', list, { permission: 'ministries.view' });
  router.post('/ministries', create, { permission: 'ministries.create' });
  router.get('/ministries/:id', read, { permission: 'ministries.view' });

  // These three admit a ministry leader, who then has the specific ministry
  // checked in the handler. See the note at the top of this file.
  router.patch('/ministries/:id', update, {
    permission: 'ministries.update',
    guard: 'permissionOrLeadership',
  });
  router.post('/ministries/:id/members', addMember, {
    permission: 'ministries.members.manage',
    guard: 'permissionOrLeadership',
  });
  router.patch('/ministries/:id/members/:memberId', updateMember, {
    permission: 'ministries.members.manage',
    guard: 'permissionOrLeadership',
  });

  router.delete('/ministries/:id', remove, { permission: 'ministries.delete' });
}
