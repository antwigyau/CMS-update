/**
 * Family (household) data access.
 *
 * As with members, every query runs through the user-scoped client, so RLS
 * decides visibility and the filters here are only about narrowing a list the
 * caller is already entitled to.
 *
 * One difference worth noting: `families` has no `search_vector`. A household
 * list is small — a congregation of 2,000 has perhaps 600 households — and a
 * generated column plus a GIN index for one field would be machinery without a
 * return. Search is a case-insensitive prefix-and-contains match on the name,
 * with the caller's wildcards escaped so `%` cannot turn into "match everything".
 */

import { createUserClient } from '../data/supabase-user.js';
import { unwrap } from '../data/errors.js';
import { notFound } from '../lib/errors.js';

const LIST_COLUMNS = 'id, family_name, household_phone, city, family_members(count)';

const DETAIL_COLUMNS = `
  id, branch_id, family_name, household_phone, household_email,
  address_line, city, region, country, notes, created_at, updated_at
`
  .replace(/\s+/g, ' ')
  .trim();

/**
 * The members of a household, with the fields the detail page shows.
 *
 * An embedded select, so this is one request rather than one per member. The
 * embedded `members` rows are subject to the members policies independently — a
 * caller who may see the household but not its members gets the rows with nulls
 * rather than a leak.
 */
const MEMBER_COLUMNS = `
  member_id, relationship, is_dependent,
  members ( member_no, full_name, membership_status, photo_path, date_of_birth )
`
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Escape the wildcards PostgREST's `ilike` would otherwise honour.
 *
 * Without this, a search for "%" matches every household, and "_" matches any
 * single character — surprising rather than dangerous, but the sort of surprise
 * that makes a search box feel broken.
 */
export function escapeLikePattern(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export function createFamiliesService({ getClient = createUserClient } = {}) {
  async function list({ accessToken, branchId, search, sort, pagination }) {
    let query = getClient(accessToken).from('families').select(LIST_COLUMNS, { count: 'exact' });

    if (branchId) query = query.eq('branch_id', branchId);
    if (search) query = query.ilike('family_name', `%${escapeLikePattern(search)}%`);

    query = query
      .order(sort.column, { ascending: sort.ascending })
      // Stable tiebreaker, so two households with the same name cannot swap
      // places between pages and hide one of themselves.
      .order('id', { ascending: true })
      .range(pagination.from, pagination.to);

    const result = await query;
    const rows = unwrap(result, { resource: 'household' });

    return { rows: rows ?? [], total: result.count ?? null };
  }

  async function get({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('families')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    const row = unwrap(result, { resource: 'household' });
    // Absent and hidden-by-RLS must be indistinguishable (ADR-035).
    if (!row) throw notFound('That household does not exist.');
    return row;
  }

  async function listMembers({ accessToken, familyId }) {
    const result = await getClient(accessToken)
      .from('family_members')
      .select(MEMBER_COLUMNS)
      .eq('family_id', familyId)
      // The head first, then the rest alphabetically — how a household is read.
      .order('relationship', { ascending: true });

    return unwrap(result, { resource: 'household' }) ?? [];
  }

  async function create({ accessToken, row }) {
    const result = await getClient(accessToken)
      .from('families')
      .insert(row)
      .select(DETAIL_COLUMNS)
      .single();

    return unwrap(result, { resource: 'household' });
  }

  async function update({ accessToken, id, patch }) {
    const result = await getClient(accessToken)
      .from('families')
      .update(patch)
      .eq('id', id)
      .select(DETAIL_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'household' });
    if (!row) throw notFound('That household does not exist.');
    return row;
  }

  /**
   * Households are hard-deleted, unlike members.
   *
   * A household is a grouping rather than a person: deleting one removes the
   * grouping and its `family_members` rows cascade, but every member record
   * survives untouched. There is nothing to preserve for history, so a soft
   * delete would only add a filter to every query.
   */
  async function remove({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('families')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle();

    const row = unwrap(result, { resource: 'household' });
    if (!row) throw notFound('That household does not exist.');
    return row;
  }

  /**
   * Add a member to a household.
   *
   * `branch_id` is written from the household's own row, never from the request:
   * the composite foreign keys then guarantee the member is in the same branch, so
   * a mismatched pair is a referential integrity error rather than a silent
   * cross-branch link.
   */
  async function addMember({ accessToken, familyId, branchId, row }) {
    const result = await getClient(accessToken)
      .from('family_members')
      .insert({ ...row, family_id: familyId, branch_id: branchId })
      .select(MEMBER_COLUMNS)
      .single();

    return unwrap(result, { resource: 'household member' });
  }

  async function updateMember({ accessToken, familyId, memberId, patch }) {
    const result = await getClient(accessToken)
      .from('family_members')
      .update(patch)
      .eq('family_id', familyId)
      .eq('member_id', memberId)
      .select(MEMBER_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'household member' });
    if (!row) throw notFound('That person is not in this household.');
    return row;
  }

  async function removeMember({ accessToken, familyId, memberId }) {
    const result = await getClient(accessToken)
      .from('family_members')
      .delete()
      .eq('family_id', familyId)
      .eq('member_id', memberId)
      .select('member_id')
      .maybeSingle();

    const row = unwrap(result, { resource: 'household member' });
    if (!row) throw notFound('That person is not in this household.');
    return row;
  }

  /** The household a member belongs to, for the member detail page. Null if none. */
  async function findForMember({ accessToken, memberId }) {
    const result = await getClient(accessToken)
      .from('family_members')
      .select('family_id, relationship, is_dependent, families ( id, family_name )')
      .eq('member_id', memberId)
      .maybeSingle();

    return unwrap(result, { resource: 'household' }) ?? null;
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
    removeMember,
    findForMember,
  };
}
