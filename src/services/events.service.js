/**
 * Event data access.
 *
 * Categories are church-wide rather than branch-scoped, which is why they are
 * fetched separately and cached by the frontend: a category list is a shared
 * vocabulary, and reports group by it across branches.
 *
 * Draft visibility is decided entirely by RLS: the policy shows a draft only to
 * someone holding `events.create` in that branch, or to the ministry's leader.
 * Nothing here filters on status for that purpose — a service module that
 * re-implemented the rule would be a second place for it to go wrong.
 */

import { createUserClient } from '../data/supabase-user.js';
import { unwrap } from '../data/errors.js';
import { notFound } from '../lib/errors.js';

const LIST_COLUMNS = `
  id, title, starts_at, ends_at, venue, status, is_public, capacity,
  event_categories ( name, colour ), ministries ( name ), event_registrations(count)
`
  .replace(/\s+/g, ' ')
  .trim();

const DETAIL_COLUMNS = `
  id, branch_id, category_id, title, description, starts_at, ends_at, venue,
  ministry_id, organizer_member_id, status, is_public, capacity,
  created_at, updated_at,
  event_categories ( name, colour ), ministries ( name ), members ( full_name )
`
  .replace(/\s+/g, ' ')
  .trim();

const REGISTRATION_COLUMNS = `
  id, member_id, guest_name, guest_phone, guest_email, status, notes, registered_at,
  members ( member_no, full_name, membership_status )
`
  .replace(/\s+/g, ' ')
  .trim();

export function escapeLikePattern(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export function createEventsService({ getClient = createUserClient } = {}) {
  async function list({
    accessToken,
    branchId,
    status,
    categoryId,
    ministryId,
    search,
    from,
    to,
    sort,
    pagination,
  }) {
    let query = getClient(accessToken).from('events').select(LIST_COLUMNS, { count: 'exact' });

    if (branchId) query = query.eq('branch_id', branchId);
    if (status) query = query.eq('status', status);
    if (categoryId) query = query.eq('category_id', categoryId);
    if (ministryId) query = query.eq('ministry_id', ministryId);
    if (search) query = query.ilike('title', `%${escapeLikePattern(search)}%`);
    // The window is on starts_at, so "September" means events that begin in
    // September — which is how a calendar month is read.
    if (from) query = query.gte('starts_at', from);
    if (to) query = query.lte('starts_at', to);

    query = query
      .order(sort.column, { ascending: sort.ascending })
      .order('id', { ascending: true })
      .range(pagination.from, pagination.to);

    const result = await query;
    const rows = unwrap(result, { resource: 'event' });

    return { rows: rows ?? [], total: result.count ?? null };
  }

  async function get({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('events')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    const row = unwrap(result, { resource: 'event' });
    if (!row) throw notFound('That event does not exist.');
    return row;
  }

  async function create({ accessToken, row }) {
    const result = await getClient(accessToken)
      .from('events')
      .insert(row)
      .select(DETAIL_COLUMNS)
      .single();

    return unwrap(result, { resource: 'event' });
  }

  async function update({ accessToken, id, patch }) {
    const result = await getClient(accessToken)
      .from('events')
      .update(patch)
      .eq('id', id)
      .select(DETAIL_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'event' });
    if (!row) throw notFound('That event does not exist.');
    return row;
  }

  async function remove({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('events')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();

    const row = unwrap(result, { resource: 'event' });
    if (!row) throw notFound('That event does not exist.');
    return row;
  }

  async function listRegistrations({ accessToken, eventId }) {
    const result = await getClient(accessToken)
      .from('event_registrations')
      .select(REGISTRATION_COLUMNS)
      .eq('event_id', eventId)
      .order('registered_at', { ascending: true });

    return unwrap(result, { resource: 'registration' }) ?? [];
  }

  /**
   * How many people currently hold a place.
   *
   * `head: true` asks PostgREST for the count without the rows, which is what the
   * capacity check needs — see the note about the race in events.routes.js.
   */
  async function countRegistrations({ accessToken, eventId }) {
    const result = await getClient(accessToken)
      .from('event_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId)
      .eq('status', 'registered');

    unwrap(result, { resource: 'registration' });
    return result.count ?? 0;
  }

  /** `branch_id` comes from the event row, never the request — ADR-040. */
  async function addRegistration({ accessToken, eventId, branchId, row }) {
    const result = await getClient(accessToken)
      .from('event_registrations')
      .insert({ ...row, event_id: eventId, branch_id: branchId })
      .select(REGISTRATION_COLUMNS)
      .single();

    return unwrap(result, { resource: 'registration' });
  }

  async function updateRegistration({ accessToken, eventId, registrationId, patch }) {
    const result = await getClient(accessToken)
      .from('event_registrations')
      .update(patch)
      .eq('id', registrationId)
      // Scoped to the event in the path, so a registration id from another event
      // cannot be edited through this one.
      .eq('event_id', eventId)
      .select(REGISTRATION_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'registration' });
    if (!row) throw notFound('That registration does not exist.');
    return row;
  }

  async function removeRegistration({ accessToken, eventId, registrationId }) {
    const result = await getClient(accessToken)
      .from('event_registrations')
      .delete()
      .eq('id', registrationId)
      .eq('event_id', eventId)
      .select('id')
      .maybeSingle();

    const row = unwrap(result, { resource: 'registration' });
    if (!row) throw notFound('That registration does not exist.');
    return row;
  }

  /** The shared category vocabulary. Active ones only unless asked otherwise. */
  async function listCategories({ accessToken, includeInactive = false }) {
    let query = getClient(accessToken)
      .from('event_categories')
      .select('id, name, description, colour, is_active');

    if (!includeInactive) query = query.eq('is_active', true);

    const result = await query.order('sort_order', { ascending: true });
    return unwrap(result, { resource: 'event category' }) ?? [];
  }

  return {
    list,
    get,
    create,
    update,
    remove,
    listRegistrations,
    countRegistrations,
    addRegistration,
    updateRegistration,
    removeRegistration,
    listCategories,
  };
}
