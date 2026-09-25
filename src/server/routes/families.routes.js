/**
 * Household endpoints.
 *
 *   GET    /api/families                        list, search, paginate
 *   POST   /api/families                        create
 *   GET    /api/families/:id                    the household and its members
 *   PATCH  /api/families/:id                    edit household details
 *   DELETE /api/families/:id                    delete the grouping (members survive)
 *   POST   /api/families/:id/members            add a member
 *   PATCH  /api/families/:id/members/:memberId  change relationship or dependency
 *   DELETE /api/families/:id/members/:memberId  remove from the household
 *
 * Membership changes are guarded by `families.update`, not by a permission of
 * their own. Adding someone to a household IS editing that household, and a
 * separate permission would be a distinction without a difference — one more
 * thing to grant, and one more thing to forget to grant.
 *
 * The branch for a membership write is read from the household row rather than
 * taken from the request, so the caller cannot nominate one. See addMember() in
 * the service for why that matters.
 */

import { created, noContent, ok } from '../../lib/http.js';
import { buildPageMeta, readPagination, readSort } from '../../lib/pagination.js';
import { validate } from '../../validation/index.js';
import {
  FAMILY_SORTS,
  familyCreateSchema,
  familyMemberAddSchema,
  familyMemberUpdateSchema,
  familyUpdateSchema,
  toFamilyListView,
  toFamilyMemberRow,
  toFamilyMemberView,
  toFamilyRow,
  toFamilyView,
} from '../../validation/families.schemas.js';
import { assertPermissionIn } from '../middleware/auth.js';
import { resolveBranchId } from '../branch.js';

/** Relationship display order: the head reads first, then the rest as entered. */
const RELATIONSHIP_ORDER = [
  'head',
  'spouse',
  'father',
  'mother',
  'son',
  'daughter',
  'brother',
  'sister',
  'grandparent',
  'grandchild',
  'other',
];

function byHouseholdOrder(a, b) {
  const difference =
    RELATIONSHIP_ORDER.indexOf(a.relationship) - RELATIONSHIP_ORDER.indexOf(b.relationship);
  if (difference !== 0) return difference;
  return (a.fullName ?? '').localeCompare(b.fullName ?? '');
}

export function registerFamilyRoutes(router, { families, audit }) {
  /* ---- list ------------------------------------------------------------- */

  async function list(context) {
    const pagination = readPagination(context.query);
    const sort = readSort(context.query.get('sort'), FAMILY_SORTS, 'name');

    const { rows, total } = await families.list({
      accessToken: context.session.accessToken,
      branchId: context.query.get('branchId') || undefined,
      search: context.query.get('search')?.trim() || undefined,
      sort,
      pagination,
    });

    return ok(rows.map(toFamilyListView), {
      ...buildPageMeta({ page: pagination.page, pageSize: pagination.pageSize, total }),
      sort: sort.key,
      ascending: sort.ascending,
    });
  }

  /* ---- create ----------------------------------------------------------- */

  async function create(context) {
    const payload = await context.json();
    const input = validate(familyCreateSchema, {
      ...payload,
      branchId: resolveBranchId(context, payload?.branchId),
    });

    assertPermissionIn(context, 'families.create', input.branchId);

    const row = await families.create({
      accessToken: context.session.accessToken,
      row: toFamilyRow(input),
    });

    context.logger.info('household created', { familyId: row.id, branchId: row.branch_id });
    await audit.record(context, {
      action: 'family.created',
      resourceType: 'family',
      resourceId: row.id,
      branchId: row.branch_id,
    });

    return created(toFamilyView(row), { location: `/api/families/${row.id}` });
  }

  /* ---- read ------------------------------------------------------------- */

  async function read(context) {
    const { accessToken } = context.session;
    const familyId = context.params.id;

    // The household is fetched first: if RLS hides it, the 404 comes from there
    // and the member query never runs.
    const family = await families.get({ accessToken, id: familyId });
    const memberRows = await families.listMembers({ accessToken, familyId });

    const members = memberRows.map(toFamilyMemberView).sort(byHouseholdOrder);

    return ok({
      ...toFamilyView(family),
      members,
      memberCount: members.length,
      // Convenient for the UI, and cheap: the alternative is every caller
      // scanning the array for the head.
      head: members.find((member) => member.relationship === 'head') ?? null,
    });
  }

  /* ---- update ----------------------------------------------------------- */

  async function update(context) {
    const input = validate(familyUpdateSchema, await context.json());

    const row = await families.update({
      accessToken: context.session.accessToken,
      id: context.params.id,
      patch: toFamilyRow(input),
    });

    const fields = Object.keys(input).sort();
    context.logger.info('household updated', { familyId: row.id, fields });
    await audit.record(context, {
      action: 'family.updated',
      resourceType: 'family',
      resourceId: row.id,
      branchId: row.branch_id,
      changes: { fields },
    });

    return ok(toFamilyView(row));
  }

  async function remove(context) {
    await families.remove({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });

    context.logger.info('household deleted', { familyId: context.params.id });
    await audit.record(context, {
      action: 'family.deleted',
      resourceType: 'family',
      resourceId: context.params.id,
    });
    return noContent();
  }

  /* ---- membership ------------------------------------------------------- */

  async function addMember(context) {
    const input = validate(familyMemberAddSchema, await context.json());
    const familyId = context.params.id;

    // Reading the household serves two purposes: it 404s if the caller may not
    // see it, and it supplies the branch so the request cannot nominate one.
    const family = await families.get({
      accessToken: context.session.accessToken,
      id: familyId,
    });

    const row = await families.addMember({
      accessToken: context.session.accessToken,
      familyId,
      branchId: family.branch_id,
      row: toFamilyMemberRow(input),
    });

    context.logger.info('household member added', {
      familyId,
      memberId: input.memberId,
      relationship: input.relationship,
    });
    await audit.record(context, {
      action: 'family.member_added',
      resourceType: 'family',
      resourceId: familyId,
      branchId: family.branch_id,
      changes: { memberId: input.memberId, relationship: input.relationship },
    });

    return created(toFamilyMemberView(row));
  }

  async function updateMember(context) {
    const input = validate(familyMemberUpdateSchema, await context.json());

    const row = await families.updateMember({
      accessToken: context.session.accessToken,
      familyId: context.params.id,
      memberId: context.params.memberId,
      patch: toFamilyMemberRow(input),
    });

    const fields = Object.keys(input).sort();
    context.logger.info('household member updated', {
      familyId: context.params.id,
      memberId: context.params.memberId,
      fields,
    });
    await audit.record(context, {
      action: 'family.member_updated',
      resourceType: 'family',
      resourceId: context.params.id,
      changes: { memberId: context.params.memberId, fields },
    });

    return ok(toFamilyMemberView(row));
  }

  async function removeMember(context) {
    await families.removeMember({
      accessToken: context.session.accessToken,
      familyId: context.params.id,
      memberId: context.params.memberId,
    });

    context.logger.info('household member removed', {
      familyId: context.params.id,
      memberId: context.params.memberId,
    });
    await audit.record(context, {
      action: 'family.member_removed',
      resourceType: 'family',
      resourceId: context.params.id,
      changes: { memberId: context.params.memberId },
    });

    return noContent();
  }

  /* ---- registration ----------------------------------------------------- */

  router.get('/families', list, { permission: 'families.view' });
  router.post('/families', create, { permission: 'families.create' });
  router.get('/families/:id', read, { permission: 'families.view' });
  router.patch('/families/:id', update, { permission: 'families.update' });
  router.delete('/families/:id', remove, { permission: 'families.delete' });

  router.post('/families/:id/members', addMember, { permission: 'families.update' });
  router.patch('/families/:id/members/:memberId', updateMember, { permission: 'families.update' });
  router.delete('/families/:id/members/:memberId', removeMember, { permission: 'families.update' });
}
