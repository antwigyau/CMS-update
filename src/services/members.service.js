/**
 * Member data access.
 *
 * Every query runs through the user-scoped Supabase client, so Row Level Security
 * applies to all of it. That is what makes the branch and ownership rules real
 * rather than conventional: this module could forget a `branch_id` filter and a
 * secretary would still see only their own branch, because the policy decides.
 *
 * The filters here are therefore about *usefulness* — narrowing a list the user is
 * already entitled to — not about access control. Two consequences worth knowing:
 *
 *   * a caller who asks for a branch they cannot see gets an empty page, not a 403
 *   * `deleted_at is null` is applied here AND in the policy, because a
 *     soft-deleted row is visible to whoever can restore it
 *
 * The client is injected so tests can substitute a recorder and assert the query
 * that was built. See the note in tests/unit/members.test.js about what that does
 * and does not prove.
 */

import { createUserClient } from '../data/supabase-user.js';
import { unwrap } from '../data/errors.js';
import { notFound } from '../lib/errors.js';
import { MEMBER_SORTS } from '../validation/members.schemas.js';

/** Columns for a list page. Narrow on purpose — a page of 100 is not 100 full records. */
const LIST_COLUMNS =
  'id, member_no, full_name, gender, phone, email, city, membership_status, date_joined, photo_path';

/** Columns for one member. Everything the detail page needs, and nothing more. */
const DETAIL_COLUMNS = `
  id, member_no, branch_id, user_id,
  first_name, middle_name, last_name, full_name,
  gender, date_of_birth, marital_status, occupation,
  phone, alt_phone, email, address_line, city, region, country, nationality,
  membership_status, date_joined, is_baptized, baptism_date, photo_path, notes,
  created_at, updated_at, deleted_at
`
  .replace(/\s+/g, ' ')
  .trim();

export function createMembersService({ getClient = createUserClient } = {}) {
  /**
   * A page of members.
   *
   * @param {object} params
   * @param {string} params.accessToken
   * @param {string} [params.branchId]
   * @param {string[]} [params.statuses]
   * @param {string} [params.search]
   * @param {boolean} [params.includeDeleted]
   * @param {{key: string, column: string, ascending: boolean}} params.sort
   * @param {{from: number, to: number}} params.pagination
   */
  async function list({
    accessToken,
    branchId,
    statuses,
    search,
    includeDeleted = false,
    sort,
    pagination,
  }) {
    let query = getClient(accessToken)
      .from('members')
      // `count: 'exact'` over the FILTERED query, so "page 7 of 24" is true.
      .select(LIST_COLUMNS, { count: 'exact' });

    if (!includeDeleted) query = query.is('deleted_at', null);
    else query = query.not('deleted_at', 'is', null);

    if (branchId) query = query.eq('branch_id', branchId);
    if (statuses?.length) query = query.in('membership_status', statuses);

    if (search) {
      // plainto_tsquery with the 'simple' configuration, matching the generated
      // column and its GIN index. Any other config would not use the index.
      query = query.textSearch('search_vector', search, { type: 'plain', config: 'simple' });
    }

    query = query
      .order(sort.column, { ascending: sort.ascending })
      // A stable tiebreaker: without it, two members with the same surname can
      // swap places between pages and one of them is never shown.
      .order('id', { ascending: true })
      .range(pagination.from, pagination.to);

    const result = await query;
    const rows = unwrap(result, { resource: 'member' });

    return { rows: rows ?? [], total: result.count ?? null };
  }

  async function get({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('members')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    const row = unwrap(result, { resource: 'member' });
    // maybeSingle() returns null rather than erroring when RLS hides the row, so
    // the 404 is produced here. "Hidden" and "absent" must look identical.
    if (!row) throw notFound('That member does not exist.');
    return row;
  }

  async function create({ accessToken, row }) {
    const result = await getClient(accessToken)
      .from('members')
      .insert(row)
      .select(DETAIL_COLUMNS)
      .single();

    return unwrap(result, { resource: 'member' });
  }

  async function update({ accessToken, id, patch }) {
    const result = await getClient(accessToken)
      .from('members')
      .update(patch)
      .eq('id', id)
      .is('deleted_at', null)
      .select(DETAIL_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'member' });
    if (!row) throw notFound('That member does not exist.');
    return row;
  }

  /**
   * Soft delete. There is no DELETE policy on `members`, so this is the only
   * removal path, and the database trigger requires `members.delete` for it.
   */
  async function softDelete({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('members')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();

    const row = unwrap(result, { resource: 'member' });
    if (!row) throw notFound('That member does not exist.');
    return row;
  }

  async function restore({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('members')
      .update({ deleted_at: null })
      .eq('id', id)
      .not('deleted_at', 'is', null)
      .select(DETAIL_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'member' });
    if (!row) throw notFound('That member does not exist, or has not been removed.');
    return row;
  }

  /**
   * The restricted directory: name, number, photo, status. Nothing else.
   *
   * Calls the database function rather than the table, because the function
   * enforces `members.view_directory` itself and caps its own page size. An usher
   * has no access to `members` at all — proven by an RLS test.
   */
  async function searchDirectory({ accessToken, branchId, search, pagination }) {
    const result = await getClient(accessToken).rpc('search_member_directory', {
      p_branch_id: branchId,
      p_query: search ?? null,
      p_limit: pagination.to - pagination.from + 1,
      p_offset: pagination.from,
    });

    return unwrap(result, { resource: 'member' }) ?? [];
  }

  /* ---- emergency contacts ----------------------------------------------- */

  // No branch_id on this table: visibility follows the member through
  // `app.can_view_member` / `app.can_edit_member` in the RLS policy. Every query
  // is still scoped by `member_id` (and the row id) so a contact belonging to one
  // member can never be reached through another's path.
  const EC_COLUMNS =
    'id, member_id, name, relationship, phone, alt_phone, address_line, is_primary, created_at, updated_at';

  async function listEmergencyContacts({ accessToken, memberId }) {
    const result = await getClient(accessToken)
      .from('member_emergency_contacts')
      .select(EC_COLUMNS)
      .eq('member_id', memberId)
      .order('is_primary', { ascending: false })
      .order('name', { ascending: true });

    return unwrap(result, { resource: 'emergency contact' }) ?? [];
  }

  async function createEmergencyContact({ accessToken, memberId, row }) {
    const result = await getClient(accessToken)
      .from('member_emergency_contacts')
      .insert({ ...row, member_id: memberId })
      .select(EC_COLUMNS)
      .single();

    return unwrap(result, { resource: 'emergency contact' });
  }

  async function updateEmergencyContact({ accessToken, memberId, id, patch }) {
    const result = await getClient(accessToken)
      .from('member_emergency_contacts')
      .update(patch)
      .eq('id', id)
      .eq('member_id', memberId)
      .select(EC_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'emergency contact' });
    if (!row) throw notFound('That emergency contact does not exist.');
    return row;
  }

  async function removeEmergencyContact({ accessToken, memberId, id }) {
    const result = await getClient(accessToken)
      .from('member_emergency_contacts')
      .delete()
      .eq('id', id)
      .eq('member_id', memberId)
      .select('id')
      .maybeSingle();

    const row = unwrap(result, { resource: 'emergency contact' });
    if (!row) throw notFound('That emergency contact does not exist.');
    return row;
  }

  /* ---- photo ------------------------------------------------------------ */

  /**
   * Set (or clear, with null) a member's photo path. Guarded by the update
   * trigger and RLS; a member row hidden from the caller returns null and 404s.
   */
  async function setPhotoPath({ accessToken, id, photoPath }) {
    const result = await getClient(accessToken)
      .from('members')
      .update({ photo_path: photoPath })
      .eq('id', id)
      .is('deleted_at', null)
      .select(DETAIL_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'member' });
    if (!row) throw notFound('That member does not exist.');
    return row;
  }

  return {
    list,
    get,
    create,
    update,
    softDelete,
    restore,
    searchDirectory,
    listEmergencyContacts,
    createEmergencyContact,
    updateEmergencyContact,
    removeEmergencyContact,
    setPhotoPath,
    MEMBER_SORTS,
  };
}
