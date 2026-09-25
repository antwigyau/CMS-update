/**
 * Finance data access.
 *
 * The lifecycle is not implemented here: `changeStatus` sends only the new
 * `status` (and a reason where the transition needs one), and the database trigger
 * `app.guard_transaction_status()` stamps the actor and timestamp from `auth.uid()`
 * and refuses an illegal transition. A service module that set `approved_by`
 * itself would be a second, forgeable source of truth for who signed off.
 *
 * `currency` is likewise never chosen here: it is read from settings by the route
 * and stamped onto the row. `getCurrency` is the read, and it fails loudly rather
 * than defaulting — a guessed currency is a silently wrong ledger.
 */

import { createUserClient } from '../data/supabase-user.js';
import { unwrap } from '../data/errors.js';
import { conflict, notFound } from '../lib/errors.js';

const LIST_COLUMNS = `
  id, kind, category_id, income_type, member_id, amount, currency, occurred_on,
  payment_method, reference, status,
  transaction_categories ( name ), members ( full_name )
`
  .replace(/\s+/g, ' ')
  .trim();

const DETAIL_COLUMNS = `
  id, branch_id, kind, category_id, income_type, member_id, amount, currency,
  occurred_on, payment_method, reference, description, receipt_path, status,
  recorded_by, submitted_by, submitted_at, approved_by, approved_at,
  rejected_by, rejected_at, rejection_reason, voided_by, voided_at, void_reason,
  created_at, updated_at,
  transaction_categories ( name, kind, code ), members ( member_no, full_name )
`
  .replace(/\s+/g, ' ')
  .trim();

export function escapeLikePattern(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export function createFinanceService({ getClient = createUserClient } = {}) {
  async function list({
    accessToken,
    branchId,
    kind,
    status,
    categoryId,
    memberId,
    from,
    to,
    search,
    sort,
    pagination,
  }) {
    let query = getClient(accessToken)
      .from('transactions')
      .select(LIST_COLUMNS, { count: 'exact' });

    if (branchId) query = query.eq('branch_id', branchId);
    if (kind) query = query.eq('kind', kind);
    if (status) query = query.eq('status', status);
    if (categoryId) query = query.eq('category_id', categoryId);
    if (memberId) query = query.eq('member_id', memberId);
    if (from) query = query.gte('occurred_on', from);
    if (to) query = query.lte('occurred_on', to);
    if (search) {
      const pattern = `%${escapeLikePattern(search)}%`;
      query = query.or(`reference.ilike.${pattern},description.ilike.${pattern}`);
    }

    query = query
      .order(sort.column, { ascending: sort.ascending })
      .order('id', { ascending: true })
      .range(pagination.from, pagination.to);

    const result = await query;
    const rows = unwrap(result, { resource: 'transaction' });

    return { rows: rows ?? [], total: result.count ?? null };
  }

  async function get({ accessToken, id }) {
    const result = await getClient(accessToken)
      .from('transactions')
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    const row = unwrap(result, { resource: 'transaction' });
    if (!row) throw notFound('That transaction does not exist.');
    return row;
  }

  async function create({ accessToken, row }) {
    const result = await getClient(accessToken)
      .from('transactions')
      .insert(row)
      .select(DETAIL_COLUMNS)
      .single();

    return unwrap(result, { resource: 'transaction' });
  }

  async function update({ accessToken, id, patch }) {
    const result = await getClient(accessToken)
      .from('transactions')
      .update(patch)
      .eq('id', id)
      .select(DETAIL_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'transaction' });
    if (!row) throw notFound('That transaction does not exist.');
    return row;
  }

  /**
   * Move a transaction through the lifecycle. Only `status` is sent (plus the
   * reason for a rejection or void); the trigger stamps who and when.
   */
  async function changeStatus({ accessToken, id, status, reason }) {
    const patch = { status };
    if (status === 'rejected') patch.rejection_reason = reason;
    if (status === 'void') patch.void_reason = reason;

    const result = await getClient(accessToken)
      .from('transactions')
      .update(patch)
      .eq('id', id)
      .select(DETAIL_COLUMNS)
      .maybeSingle();

    const row = unwrap(result, { resource: 'transaction' });
    if (!row) throw notFound('That transaction does not exist.');
    return row;
  }

  /** How many transactions are waiting for approval — for the queue badge. */
  async function countPending({ accessToken, branchId }) {
    let query = getClient(accessToken)
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending_approval');

    if (branchId) query = query.eq('branch_id', branchId);

    const result = await query;
    unwrap(result, { resource: 'transaction' });
    return result.count ?? 0;
  }

  /* ---- categories ------------------------------------------------------- */

  async function listCategories({ accessToken, kind, includeInactive = false }) {
    let query = getClient(accessToken)
      .from('transaction_categories')
      .select('id, kind, name, code, description, is_active, sort_order');

    if (kind) query = query.eq('kind', kind);
    if (!includeInactive) query = query.eq('is_active', true);

    const result = await query
      .order('kind', { ascending: true })
      .order('sort_order', { ascending: true });

    return unwrap(result, { resource: 'transaction category' }) ?? [];
  }

  async function createCategory({ accessToken, row }) {
    const result = await getClient(accessToken)
      .from('transaction_categories')
      .insert(row)
      .select('id, kind, name, code, description, is_active, sort_order')
      .single();

    return unwrap(result, { resource: 'transaction category' });
  }

  async function updateCategory({ accessToken, id, patch }) {
    const result = await getClient(accessToken)
      .from('transaction_categories')
      .update(patch)
      .eq('id', id)
      .select('id, kind, name, code, description, is_active, sort_order')
      .maybeSingle();

    const row = unwrap(result, { resource: 'transaction category' });
    if (!row) throw notFound('That category does not exist.');
    return row;
  }

  /* ---- currency --------------------------------------------------------- */

  /**
   * The configured transaction currency, read from settings on each write.
   *
   * Not cached at module scope on purpose: in a serverless environment that would
   * pin a stale value until a cold start, so an administrator correcting the
   * currency would appear to have no effect. Writes are rare enough that one small
   * read per write is the right trade.
   *
   * Fails loudly when unset — the whole point of seeding it deliberately.
   */
  async function getCurrency({ accessToken }) {
    const result = await getClient(accessToken)
      .from('settings')
      .select('value')
      .eq('scope', 'global')
      .eq('key', 'finance.currency')
      .maybeSingle();

    const row = unwrap(result, { resource: 'setting' });
    const value = typeof row?.value === 'string' ? row.value.trim() : null;

    if (!value) {
      throw conflict(
        'Finance is not configured: an administrator must set the transaction currency before transactions can be recorded.',
      );
    }
    return value;
  }

  return {
    list,
    get,
    create,
    update,
    changeStatus,
    countPending,
    listCategories,
    createCategory,
    updateCategory,
    getCurrency,
  };
}
