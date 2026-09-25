/**
 * Ministry data access.
 *
 * The membership table keeps history: someone who leaves gets `left_on` set
 * rather than being deleted, because past membership is what explains past
 * attendance and past leadership. Every "current membership" query is therefore
 * filtered on `left_on is null`, and every uniqueness rule in the schema is a
 * partial index over the same condition.
 *
 * That has one consequence worth stating: `removeMember` is an update, not a
 * delete. A membership row is only ever hard-deleted when it was created by
 * mistake and has no history — which is not a case the API offers.
 */

import { createUserClient } from '../data/supabase-user.js';
import { unwrap } from '../data/errors.js';
import { notFound } from '../lib/errors.js';

const LIST_COLUMNS = 'id, name, code, status, meeting_day, meeting_time, ministry_members(count)';

const DETAIL_COLUMNS = `
  id, branch_id, name, code, description, status,
  meeting_day, meeting_time, meeting_location, created_at, updated_at
`
  .replace(/\s+/g, ' ')
  .trim();

const MEMBER_COLUMNS = `
  id, member_id, role_in_ministry, joined_on, left_on,
  members ( member_no, full_name, membership_status, photo_path )
`
  .replace(/\s+/g, ' ')
  .trim();

export function escapeLikePattern(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export function createMinistriesService({ getClient = createUserClient } = {}) {
  async function list({ accessToken, branchId, search, status, sort, pagination }) {
    let query = getClient(accessToken).from('ministries').select(LIST_COLUMNS, { count: 'exact' });

    if (branchId) query = query.eq('branch_id', branchId);
    if (status) query = query.eq('status', status);
    if (search) query = query.ilike('name', `%${escapeLikePattern(search)}%`);

    query = query
      .order(sort.column, { ascending: sort.ascending })
      .order('id', { ascending: true })
      .range(pagination.from, pagination.to);

    const result = await query;
    const rows = unwrap(result, { resource: 'ministry' });

    return { rows: rows ?? [], total: result.count ?? null };
  }

  async function get({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('ministries')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    const row = unwrap(result, { resource: 'ministry' });
    if (!row) throw notFound('That ministry does not exist.');
    return row;
  }

  /**
   * Members of a ministry.
   *
   * `includeFormer` decides whether people who have left are returned. The
   * default is current members only: a ministry roll that silently includes
   * everyone who ever passed through is not a roll.
   */
  async function listMembers({ accessToken, ministryId, includeFormer = false }) {
    let query = getClient(accessToken)
      .from('ministry_members')
      .select(MEMBER_COLUMNS)
      .eq('ministry_id', ministryId);

    if (!includeFormer) query = query.is('left_on', null);

    const result = await query.order('joined_on', { ascending: true });
    return unwrap(result, { resource: 'ministry' }) ?? [];
  }

  async function create({ accessToken, row }) {
    const result = await getClient(accessToken)
      .from('ministries')
      .insert(row)
      .select(DETAIL_COLUMNS)
      .single();

    return unwrap(result, { resource: 'ministry' });
  }

  async function update({ accessToken, id, patch }) {
    const result = await getClient(accessToken)
      .from('ministries')
      .update(patch)
      .eq('id', id)
      .select(DETAIL_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'ministry' });
    if (!row) throw notFound('That ministry does not exist.');
    return row;
  }

  async function remove({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('ministries')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();

    const row = unwrap(result, { resource: 'ministry' });
    if (!row) throw notFound('That ministry does not exist.');
    return row;
  }

  /** `branch_id` comes from the ministry row, never the request — ADR-040. */
  async function addMember({ accessToken, ministryId, branchId, row }) {
    const result = await getClient(accessToken)
      .from('ministry_members')
      .insert({ ...row, ministry_id: ministryId, branch_id: branchId })
      .select(MEMBER_COLUMNS)
      .single();

    return unwrap(result, { resource: 'ministry member' });
  }

  /**
   * Change a role, or end a membership by setting `left_on`.
   *
   * Matched on the active row: `left_on is null`. Without that filter, editing
   * someone who has previously been in the ministry twice would be ambiguous, and
   * PostgREST would update both rows.
   */
  async function updateMember({ accessToken, ministryId, memberId, patch }) {
    const result = await getClient(accessToken)
      .from('ministry_members')
      .update(patch)
      .eq('ministry_id', ministryId)
      .eq('member_id', memberId)
      .is('left_on', null)
      .select(MEMBER_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'ministry member' });
    if (!row) throw notFound('That person is not currently in this ministry.');
    return row;
  }

  /** The ministries a member currently belongs to, for the member detail page. */
  async function listForMember({ accessToken, memberId }) {
    const result = await getClient(accessToken)
      .from('ministry_members')
      .select('ministry_id, role_in_ministry, joined_on, ministries ( id, name, status )')
      .eq('member_id', memberId)
      .is('left_on', null);

    return unwrap(result, { resource: 'ministry' }) ?? [];
  }

  return {
    list,
    get,
    listMembers,
    create,
    update,
    remove,
    addMember,
    updateMember,
    listForMember,
  };
}
