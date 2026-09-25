/**
 * Event endpoints.
 *
 *   GET    /api/event-categories                              the shared vocabulary
 *   GET    /api/events                                        list, filter, paginate
 *   POST   /api/events                                         create (as a draft)
 *   GET    /api/events/:id                                     one event
 *   PATCH  /api/events/:id                                     edit its details
 *   POST   /api/events/:id/status                               publish, cancel, complete
 *   DELETE /api/events/:id
 *   GET    /api/events/:id/registrations
 *   POST   /api/events/:id/registrations
 *   PATCH  /api/events/:id/registrations/:registrationId
 *   DELETE /api/events/:id/registrations/:registrationId
 *
 * **Why publishing is its own endpoint.** `events.publish` is a separate permission
 * from `events.update`, so a `PATCH { status: 'published' }` would let anyone who
 * may correct a typo also announce the event to the whole congregation. The
 * lifecycle therefore lives at `POST /:id/status`, and `status` is absent from the
 * update schema entirely (ADR-049).
 *
 * A ministry leader may create and edit an event for their own ministry — the RLS
 * policies read `permission OR is_ministry_leader(ministry_id)` — but may not
 * publish, delete, or manage registrations. Same shape as ADR-042 and ADR-046.
 */

import { conflict, forbidden, validationFailed } from '../../lib/errors.js';
import { created, noContent, ok } from '../../lib/http.js';
import { buildPageMeta, readPagination, readSort } from '../../lib/pagination.js';
import { validate } from '../../validation/index.js';
import {
  EVENT_SORTS,
  EVENT_STATUSES,
  eventCreateSchema,
  eventStatusSchema,
  eventUpdateSchema,
  registrationCreateSchema,
  registrationUpdateSchema,
  toCategoryView,
  toEventListView,
  toEventRow,
  toEventView,
  toRegistrationRow,
  toRegistrationView,
} from '../../validation/events.schemas.js';
import { assertPermissionIn } from '../middleware/auth.js';
import { resolveBranchId } from '../branch.js';

/**
 * Which status changes are allowed, and what each needs.
 *
 * `publish` is the only one that makes an event visible beyond the people who can
 * already see drafts, so it is the only one gated on `events.publish`.
 */
const STATUS_RULES = Object.freeze({
  published: { from: ['draft', 'cancelled'], permission: 'events.publish' },
  ongoing: { from: ['published'], permission: 'events.update' },
  completed: { from: ['published', 'ongoing'], permission: 'events.update' },
  cancelled: { from: ['draft', 'published', 'ongoing'], permission: 'events.update' },
  draft: { from: ['cancelled'], permission: 'events.update' },
});

function readEnum(query, name, allowed) {
  const value = query.get(name)?.trim();
  if (!value) return undefined;

  if (!allowed.includes(value)) {
    throw validationFailed(`That ${name} filter is not recognised.`, {
      details: { fields: { [name]: `Use one of: ${allowed.join(', ')}.` } },
    });
  }
  return value;
}

function readInstant(query, name) {
  const value = query.get(name)?.trim();
  if (!value) return undefined;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw validationFailed('That date filter is not a date.', {
      details: { fields: { [name]: 'Use an ISO date, for example 2026-09-01.' } },
    });
  }
  return parsed.toISOString();
}

export function registerEventRoutes(router, { events, audit }) {
  /** Authority over one event: the branch permission, or leading its ministry. */
  function assertEventAuthority(context, permission, event) {
    if (context.can(permission, event.branch_id)) return;
    if (event.ministry_id && context.leadsMinistry(event.ministry_id)) return;

    context.logger.warn('event authority denied', { permission, eventId: event.id });
    throw forbidden('You do not have permission to do that.');
  }

  /* ---- categories ------------------------------------------------------- */

  async function listCategories(context) {
    const rows = await events.listCategories({
      accessToken: context.session.accessToken,
      includeInactive: context.query.get('all') === '1',
    });

    return ok(rows.map(toCategoryView));
  }

  /* ---- list ------------------------------------------------------------- */

  async function list(context) {
    const pagination = readPagination(context.query);
    const sort = readSort(context.query.get('sort'), EVENT_SORTS, 'starts');

    const { rows, total } = await events.list({
      accessToken: context.session.accessToken,
      branchId: context.query.get('branchId') || undefined,
      status: readEnum(context.query, 'status', EVENT_STATUSES),
      categoryId: context.query.get('categoryId') || undefined,
      ministryId: context.query.get('ministryId') || undefined,
      search: context.query.get('search')?.trim() || undefined,
      from: readInstant(context.query, 'from'),
      to: readInstant(context.query, 'to'),
      sort,
      pagination,
    });

    return ok(rows.map(toEventListView), {
      ...buildPageMeta({ page: pagination.page, pageSize: pagination.pageSize, total }),
      sort: sort.key,
      ascending: sort.ascending,
    });
  }

  /* ---- create ----------------------------------------------------------- */

  async function create(context) {
    const payload = await context.json();
    const input = validate(eventCreateSchema, {
      ...payload,
      branchId: resolveBranchId(context, payload?.branchId),
    });

    // A ministry leader may create an event for their own ministry.
    const leadsThisMinistry = Boolean(input.ministryId) && context.leadsMinistry(input.ministryId);
    if (!leadsThisMinistry) {
      assertPermissionIn(context, 'events.create', input.branchId);
    }

    // Always born a draft. Publishing is a separate act with its own permission,
    // so an event cannot be announced by the same request that creates it.
    const row = await events.create({
      accessToken: context.session.accessToken,
      row: { ...toEventRow(input), status: 'draft' },
    });

    context.logger.info('event created', { eventId: row.id, branchId: row.branch_id });
    await audit.record(context, {
      action: 'event.created',
      resourceType: 'event',
      resourceId: row.id,
      branchId: row.branch_id,
    });

    return created(toEventView(row), { location: `/api/events/${row.id}` });
  }

  /* ---- read ------------------------------------------------------------- */

  async function read(context) {
    const { accessToken } = context.session;
    const event = await events.get({ accessToken, id: context.params.id });

    const registeredCount = context.can('events.view', event.branch_id)
      ? await events.countRegistrations({ accessToken, eventId: event.id })
      : null;

    return ok({
      ...toEventView(event),
      registeredCount,
      placesLeft:
        event.capacity === null || registeredCount === null
          ? null
          : Math.max(0, event.capacity - registeredCount),
      youLead: Boolean(event.ministry_id) && context.leadsMinistry(event.ministry_id),
      canEdit:
        context.can('events.update', event.branch_id) ||
        (Boolean(event.ministry_id) && context.leadsMinistry(event.ministry_id)),
      canPublish: context.can('events.publish', event.branch_id),
      canDelete: context.can('events.delete', event.branch_id),
      canManageRegistrations: context.can('events.attendance.manage', event.branch_id),
    });
  }

  /* ---- update ----------------------------------------------------------- */

  async function update(context) {
    const input = validate(eventUpdateSchema, await context.json());
    const { accessToken } = context.session;

    const event = await events.get({ accessToken, id: context.params.id });
    assertEventAuthority(context, 'events.update', event);

    // Moving an event to a different ministry changes who may edit it, so it needs
    // the branch permission rather than the leader's own authority.
    if (input.ministryId !== undefined && input.ministryId !== event.ministry_id) {
      assertPermissionIn(context, 'events.update', event.branch_id);
    }

    const row = await events.update({
      accessToken,
      id: event.id,
      patch: toEventRow(input),
    });

    const fields = Object.keys(input).sort();
    context.logger.info('event updated', { eventId: row.id, fields });
    await audit.record(context, {
      action: 'event.updated',
      resourceType: 'event',
      resourceId: row.id,
      branchId: event.branch_id,
      changes: { fields },
    });

    return ok(toEventView(row));
  }

  /* ---- lifecycle -------------------------------------------------------- */

  async function changeStatus(context) {
    const { status } = validate(eventStatusSchema, await context.json());
    const { accessToken } = context.session;

    const event = await events.get({ accessToken, id: context.params.id });

    if (event.status === status) {
      throw conflict(`This event is already ${status}.`);
    }

    const rule = STATUS_RULES[status];
    if (!rule.from.includes(event.status)) {
      throw conflict(`An event cannot go from ${event.status} to ${status}.`);
    }

    // Publishing needs the permission outright — leadership does not confer it,
    // because publishing announces the event beyond the ministry.
    if (status === 'published') {
      assertPermissionIn(context, rule.permission, event.branch_id);
    } else {
      assertEventAuthority(context, rule.permission, event);
    }

    const row = await events.update({ accessToken, id: event.id, patch: { status } });

    context.logger.info('event status changed', {
      eventId: row.id,
      from: event.status,
      to: status,
    });
    await audit.record(context, {
      action: status === 'published' ? 'event.published' : 'event.status_changed',
      resourceType: 'event',
      resourceId: row.id,
      branchId: event.branch_id,
      changes: { from: event.status, to: status },
    });

    return ok(toEventView(row));
  }

  async function remove(context) {
    const { accessToken } = context.session;
    const event = await events.get({ accessToken, id: context.params.id });

    // Deleting takes the event and its registrations with it, so leadership does
    // not confer it. Cancelling is the reversible option.
    assertPermissionIn(context, 'events.delete', event.branch_id);

    await events.remove({ accessToken, id: event.id });

    context.logger.info('event deleted', { eventId: event.id });
    await audit.record(context, {
      action: 'event.deleted',
      resourceType: 'event',
      resourceId: event.id,
      branchId: event.branch_id,
    });
    return noContent();
  }

  /* ---- registrations ---------------------------------------------------- */

  async function listRegistrations(context) {
    const { accessToken } = context.session;
    const event = await events.get({ accessToken, id: context.params.id });

    const rows = await events.listRegistrations({ accessToken, eventId: event.id });

    return ok(rows.map(toRegistrationView), {
      total: rows.length,
      capacity: event.capacity,
    });
  }

  async function addRegistration(context) {
    const input = validate(registrationCreateSchema, await context.json());
    const { accessToken } = context.session;

    const event = await events.get({ accessToken, id: context.params.id });
    assertPermissionIn(context, 'events.attendance.manage', event.branch_id);

    if (event.status === 'cancelled') {
      throw conflict('This event has been cancelled.');
    }

    /**
     * Capacity is checked here, and the check races: two simultaneous
     * registrations can both read a count of 49 against a capacity of 50 and both
     * succeed. Exceeding by one on a church event is a chair, not a defect, so the
     * cost of closing it — a trigger or a serialisable transaction — is not worth
     * paying yet. Recorded as a known gap in docs/SECURITY.md.
     */
    if (event.capacity !== null) {
      const taken = await events.countRegistrations({ accessToken, eventId: event.id });
      if (taken >= event.capacity) {
        throw conflict('This event is full.', {
          details: { fields: { memberId: `All ${event.capacity} places are taken.` } },
        });
      }
    }

    const row = await events.addRegistration({
      accessToken,
      eventId: event.id,
      branchId: event.branch_id,
      row: toRegistrationRow(input),
    });

    context.logger.info('event registration added', {
      eventId: event.id,
      memberId: input.memberId ?? null,
    });
    await audit.record(context, {
      action: 'event.registration_added',
      resourceType: 'event',
      resourceId: event.id,
      branchId: event.branch_id,
      changes: { registrationId: row.id },
    });

    return created(toRegistrationView(row));
  }

  async function updateRegistration(context) {
    const input = validate(registrationUpdateSchema, await context.json());
    const { accessToken } = context.session;

    const event = await events.get({ accessToken, id: context.params.id });
    assertPermissionIn(context, 'events.attendance.manage', event.branch_id);

    const row = await events.updateRegistration({
      accessToken,
      eventId: event.id,
      registrationId: context.params.registrationId,
      patch: toRegistrationRow(input),
    });

    const fields = Object.keys(input).sort();
    context.logger.info('event registration updated', {
      eventId: event.id,
      registrationId: row.id,
      fields,
    });
    await audit.record(context, {
      action: 'event.registration_updated',
      resourceType: 'event',
      resourceId: event.id,
      branchId: event.branch_id,
      changes: { registrationId: row.id, fields },
    });

    return ok(toRegistrationView(row));
  }

  async function removeRegistration(context) {
    const { accessToken } = context.session;
    const event = await events.get({ accessToken, id: context.params.id });

    assertPermissionIn(context, 'events.attendance.manage', event.branch_id);

    await events.removeRegistration({
      accessToken,
      eventId: event.id,
      registrationId: context.params.registrationId,
    });

    context.logger.info('event registration removed', {
      eventId: event.id,
      registrationId: context.params.registrationId,
    });
    await audit.record(context, {
      action: 'event.registration_removed',
      resourceType: 'event',
      resourceId: event.id,
      branchId: event.branch_id,
      changes: { registrationId: context.params.registrationId },
    });

    return noContent();
  }

  /* ---- registration ----------------------------------------------------- */

  router.get('/event-categories', listCategories, { permission: 'events.view' });

  router.get('/events', list, { permission: 'events.view' });
  router.post('/events', create, {
    permission: 'events.create',
    guard: 'permissionOrLeadership',
  });
  router.get('/events/:id', read, { permission: 'events.view' });
  router.patch('/events/:id', update, {
    permission: 'events.update',
    guard: 'permissionOrLeadership',
  });
  router.post('/events/:id/status', changeStatus, {
    permission: 'events.update',
    guard: 'permissionOrLeadership',
  });
  router.delete('/events/:id', remove, { permission: 'events.delete' });

  router.get('/events/:id/registrations', listRegistrations, { permission: 'events.view' });
  router.post('/events/:id/registrations', addRegistration, {
    permission: 'events.attendance.manage',
  });
  router.patch('/events/:id/registrations/:registrationId', updateRegistration, {
    permission: 'events.attendance.manage',
  });
  router.delete('/events/:id/registrations/:registrationId', removeRegistration, {
    permission: 'events.attendance.manage',
  });
}
