/**
 * Member endpoints.
 *
 *   GET    /api/members            list, filter, search, paginate
 *   GET    /api/members/directory  name-and-photo lookup for attendance taking
 *   POST   /api/members            create
 *   GET    /api/members/:id        one member, in full
 *   PATCH  /api/members/:id        edit
 *   DELETE /api/members/:id        soft delete
 *   POST   /api/members/:id/restore
 *
 * A note on branch scoping, because it is the subtle part.
 *
 * `requirePermission('members.view')` asks "does this caller hold the permission
 * anywhere at all?". It cannot ask about a specific branch, because at guard time
 * the row has not been read and its branch is unknown. For a LIST that is fine:
 * RLS narrows the result to the branches the caller may see, so a request for
 * someone else's branch returns an empty page rather than a leak.
 *
 * For a CREATE the branch arrives in the payload, so it *can* be checked, and is —
 * `assertPermissionIn` gives a clean 403 instead of letting the insert fail on a
 * policy. For UPDATE and DELETE the row's branch is known only to the database, so
 * RLS and the field-level triggers are what enforce it. That is deliberate: those
 * are the checks that cannot be bypassed by a bug in this file.
 */

import { forbidden, validationFailed } from '../../lib/errors.js';
import { created, noContent, ok } from '../../lib/http.js';
import { buildPageMeta, readPagination, readSort } from '../../lib/pagination.js';
import { validate } from '../../validation/index.js';
import {
  MEMBERSHIP_STATUSES,
  MEMBER_SORTS,
  memberCreateSchema,
  memberUpdateSchema,
  toMemberListView,
  toMemberRow,
  toMemberView,
} from '../../validation/members.schemas.js';
import {
  emergencyContactCreateSchema,
  emergencyContactUpdateSchema,
  toEmergencyContactRow,
  toEmergencyContactView,
} from '../../validation/emergency-contacts.schemas.js';
import { PHOTO_CONTENT_TYPES } from '../../services/storage.service.js';
import { assertPermissionIn } from '../middleware/auth.js';
import { resolveBranchId } from '../branch.js';

/** Status filters, ignoring any value that is not a real status. */
function readStatuses(query) {
  const requested = [...query.getAll('status'), ...(query.get('statuses')?.split(',') ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);

  const valid = requested.filter((value) => MEMBERSHIP_STATUSES.includes(value));

  // An unrecognised status is a stale bookmark or an edited URL. Silently
  // dropping it would show an unfiltered list that looks filtered, so say so.
  if (requested.length > 0 && valid.length === 0) {
    throw validationFailed('That membership status filter is not recognised.', {
      details: { fields: { status: `Use one of: ${MEMBERSHIP_STATUSES.join(', ')}.` } },
    });
  }
  return valid;
}

export function registerMemberRoutes(router, { members, audit, storage }) {
  /* ---- list ------------------------------------------------------------- */

  async function list(context) {
    const pagination = readPagination(context.query);
    const sort = readSort(context.query.get('sort'), MEMBER_SORTS, 'name');
    const search = context.query.get('search')?.trim() || undefined;
    const branchId = context.query.get('branchId') || undefined;
    const statuses = readStatuses(context.query);

    // Only whoever can restore a member may list removed ones — matching the
    // members_select_deleted policy rather than duplicating its rule.
    const includeDeleted = context.query.get('deleted') === '1';
    if (includeDeleted && !context.can('members.delete')) {
      throw forbidden('You do not have permission to do that.');
    }

    const { rows, total } = await members.list({
      accessToken: context.session.accessToken,
      branchId,
      statuses,
      search,
      includeDeleted,
      sort,
      pagination,
    });

    return ok(rows.map(toMemberListView), {
      ...buildPageMeta({ page: pagination.page, pageSize: pagination.pageSize, total }),
      sort: sort.key,
      ascending: sort.ascending,
    });
  }

  /* ---- directory -------------------------------------------------------- */

  async function directory(context) {
    const pagination = readPagination(context.query, { defaultPageSize: 20 });
    const branchId = resolveBranchId(context, context.query.get('branchId') || undefined);

    const rows = await members.searchDirectory({
      accessToken: context.session.accessToken,
      branchId,
      search: context.query.get('search')?.trim() || undefined,
      pagination,
    });

    // The database function caps its own page size, so a full page here does not
    // prove another exists — hasNext is left unknown rather than guessed.
    return ok(
      rows.map((row) => ({
        id: row.id,
        memberNo: row.member_no,
        fullName: row.full_name,
        photoPath: row.photo_path,
        membershipStatus: row.membership_status,
      })),
      buildPageMeta({ page: pagination.page, pageSize: pagination.pageSize, total: null }),
    );
  }

  /* ---- create ----------------------------------------------------------- */

  async function create(context) {
    const payload = await context.json();
    const input = validate(memberCreateSchema, {
      ...payload,
      branchId: resolveBranchId(context, payload?.branchId),
    });

    assertPermissionIn(context, 'members.create', input.branchId);

    const row = await members.create({
      accessToken: context.session.accessToken,
      row: toMemberRow(input),
    });

    context.logger.info('member created', { memberId: row.id, branchId: row.branch_id });
    await audit.record(context, {
      action: 'member.created',
      resourceType: 'member',
      resourceId: row.id,
      branchId: row.branch_id,
    });

    return created(toMemberView(row), { location: `/api/members/${row.id}` });
  }

  /* ---- read one --------------------------------------------------------- */

  async function read(context) {
    const row = await members.get({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });
    return ok(toMemberView(row));
  }

  /* ---- update ----------------------------------------------------------- */

  async function update(context) {
    const input = validate(memberUpdateSchema, await context.json());

    const row = await members.update({
      accessToken: context.session.accessToken,
      id: context.params.id,
      patch: toMemberRow(input),
    });

    const fields = Object.keys(input).sort();
    context.logger.info('member updated', {
      memberId: row.id,
      // Field names only. The values are personal data and do not belong in a log.
      fields,
    });
    await audit.record(context, {
      action: 'member.updated',
      resourceType: 'member',
      resourceId: row.id,
      branchId: row.branch_id,
      // Field names only — the audit log is not a place to duplicate PII.
      changes: { fields },
    });

    return ok(toMemberView(row));
  }

  /* ---- remove and restore ---------------------------------------------- */

  async function remove(context) {
    await members.softDelete({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });

    context.logger.info('member removed', { memberId: context.params.id });
    await audit.record(context, {
      action: 'member.removed',
      resourceType: 'member',
      resourceId: context.params.id,
    });
    return noContent();
  }

  async function restore(context) {
    const row = await members.restore({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });

    context.logger.info('member restored', { memberId: row.id });
    await audit.record(context, {
      action: 'member.restored',
      resourceType: 'member',
      resourceId: row.id,
      branchId: row.branch_id,
    });
    return ok(toMemberView(row));
  }

  /* ---- emergency contacts ----------------------------------------------- */

  // Guarded through the member: reading needs members.view, writing members.update.
  // RLS narrows both to the specific member's branch (or the member's own record)
  // via app.can_view_member / app.can_edit_member — the guard only checks "may they
  // do this anywhere", the policy checks "for this member".

  async function listContacts(context) {
    const rows = await members.listEmergencyContacts({
      accessToken: context.session.accessToken,
      memberId: context.params.id,
    });
    return ok(rows.map(toEmergencyContactView));
  }

  async function createContact(context) {
    const input = validate(emergencyContactCreateSchema, await context.json());
    const row = await members.createEmergencyContact({
      accessToken: context.session.accessToken,
      memberId: context.params.id,
      row: toEmergencyContactRow(input),
    });

    context.logger.info('emergency contact added', {
      memberId: context.params.id,
      contactId: row.id,
    });
    await audit.record(context, {
      action: 'emergency_contact.added',
      resourceType: 'emergency_contact',
      resourceId: row.id,
      changes: { memberId: context.params.id },
    });
    return created(toEmergencyContactView(row));
  }

  async function updateContact(context) {
    const input = validate(emergencyContactUpdateSchema, await context.json());
    const row = await members.updateEmergencyContact({
      accessToken: context.session.accessToken,
      memberId: context.params.id,
      id: context.params.contactId,
      patch: toEmergencyContactRow(input),
    });

    const fields = Object.keys(input).sort();
    context.logger.info('emergency contact updated', {
      memberId: context.params.id,
      contactId: row.id,
      fields,
    });
    await audit.record(context, {
      action: 'emergency_contact.updated',
      resourceType: 'emergency_contact',
      resourceId: row.id,
      changes: { memberId: context.params.id, fields },
    });
    return ok(toEmergencyContactView(row));
  }

  async function removeContact(context) {
    await members.removeEmergencyContact({
      accessToken: context.session.accessToken,
      memberId: context.params.id,
      id: context.params.contactId,
    });

    context.logger.info('emergency contact removed', {
      memberId: context.params.id,
      contactId: context.params.contactId,
    });
    await audit.record(context, {
      action: 'emergency_contact.removed',
      resourceType: 'emergency_contact',
      resourceId: context.params.contactId,
      changes: { memberId: context.params.id },
    });
    return noContent();
  }

  /* ---- photo ------------------------------------------------------------ */

  // The file never passes through the API. Upload is a two-step handshake: mint a
  // signed URL the browser PUTs the bytes to, then confirm the resulting path.
  // Reading is a short-lived signed URL, minted only for a caller who may see the
  // member. Storage's own RLS (keyed on the branch in the path) is the real guard.

  async function photoUploadUrl(context) {
    const body = await context.json();
    const contentType = typeof body?.contentType === 'string' ? body.contentType : '';
    if (!Object.hasOwn(PHOTO_CONTENT_TYPES, contentType)) {
      throw validationFailed('That image type is not supported.', {
        details: { fields: { contentType: 'Use image/jpeg, image/png, or image/webp.' } },
      });
    }

    const member = await members.get({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });
    const upload = await storage.createMemberPhotoUpload({
      accessToken: context.session.accessToken,
      branchId: member.branch_id,
      memberId: member.id,
      contentType,
    });

    return ok(upload);
  }

  async function setPhoto(context) {
    const body = await context.json();
    const path = typeof body?.path === 'string' ? body.path.trim() : '';

    const member = await members.get({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });

    // The path must live under this member's own prefix, so a caller cannot point
    // the record at another member's object and read it later through the signer.
    if (!path.startsWith(`${member.branch_id}/${member.id}/`)) {
      throw validationFailed('That photo path does not belong to this member.', {
        details: { fields: { path: 'Upload the photo first, then confirm the path it returned.' } },
      });
    }

    const row = await members.setPhotoPath({
      accessToken: context.session.accessToken,
      id: member.id,
      photoPath: path,
    });

    context.logger.info('member photo set', { memberId: member.id });
    await audit.record(context, {
      action: 'member.photo_changed',
      resourceType: 'member',
      resourceId: member.id,
      branchId: member.branch_id,
    });

    return ok(toMemberView(row));
  }

  async function getPhoto(context) {
    const member = await members.get({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });
    if (!member.photo_path) return ok({ url: null });

    const url = await storage.signMemberPhoto({
      accessToken: context.session.accessToken,
      path: member.photo_path,
    });
    return ok({ url });
  }

  async function removePhoto(context) {
    const member = await members.get({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });

    if (member.photo_path) {
      await storage.removeMemberPhoto({
        accessToken: context.session.accessToken,
        path: member.photo_path,
      });
    }

    await members.setPhotoPath({
      accessToken: context.session.accessToken,
      id: member.id,
      photoPath: null,
    });

    context.logger.info('member photo removed', { memberId: member.id });
    await audit.record(context, {
      action: 'member.photo_removed',
      resourceType: 'member',
      resourceId: member.id,
      branchId: member.branch_id,
    });

    return noContent();
  }

  /* ---- registration ----------------------------------------------------- */

  // `/members/directory` is registered before `/members/:id` so the literal path
  // wins; the router matches in registration order.
  router.get('/members', list, { permission: 'members.view' });
  router.get('/members/directory', directory, { permission: 'members.view_directory' });
  router.post('/members', create, { permission: 'members.create' });
  router.get('/members/:id', read, { permission: 'members.view' });
  router.patch('/members/:id', update, { permission: 'members.update' });
  router.delete('/members/:id', remove, { permission: 'members.delete' });
  router.post('/members/:id/restore', restore, { permission: 'members.delete' });

  router.get('/members/:id/emergency-contacts', listContacts, { permission: 'members.view' });
  router.post('/members/:id/emergency-contacts', createContact, { permission: 'members.update' });
  router.patch('/members/:id/emergency-contacts/:contactId', updateContact, {
    permission: 'members.update',
  });
  router.delete('/members/:id/emergency-contacts/:contactId', removeContact, {
    permission: 'members.update',
  });

  router.get('/members/:id/photo', getPhoto, { permission: 'members.view' });
  router.post('/members/:id/photo/upload-url', photoUploadUrl, {
    permission: 'members.photo.manage',
  });
  router.patch('/members/:id/photo', setPhoto, { permission: 'members.photo.manage' });
  router.delete('/members/:id/photo', removePhoto, { permission: 'members.photo.manage' });
}
