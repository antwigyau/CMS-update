/**
 * Finance endpoints.
 *
 *   GET    /api/transaction-categories                     the shared vocabulary
 *   POST   /api/transaction-categories                     add a category
 *   PATCH  /api/transaction-categories/:id                 edit / deactivate one
 *   GET    /api/transactions                               list, filter, paginate
 *   POST   /api/transactions                               record (as a draft)
 *   GET    /api/transactions/:id                            one transaction
 *   PATCH  /api/transactions/:id                            edit a draft/rejected one
 *   POST   /api/transactions/:id/status                     submit, approve, reject, void
 *
 * There is deliberately **no DELETE**. An approved transaction is reversed by
 * voiding it, which keeps the row and its reason — a deleted financial record is
 * an audit hole. The database has no delete policy either.
 *
 * **Why the lifecycle is its own endpoint** (ADR-049 analogue): submitting,
 * approving, rejecting, and voiding are four separate permissions. A
 * `PATCH { status }` would let anyone who may fix a typo in a draft also approve
 * it for payment. So `status` is absent from the update schema, and each
 * transition is gated on its own permission inside `POST /:id/status`.
 *
 * **The second signature.** `finance.approve` is not enough on its own: the person
 * approving must not be the person who submitted. That is enforced by the database
 * constraint `transactions_no_self_approval` (which even a Super Administrator
 * holding both permissions cannot bypass) and mirrored here as a clean 403 and a
 * `canApprove` flag, so the button is hidden and the refusal is legible.
 */

import { conflict, forbidden } from '../../lib/errors.js';
import { created, ok } from '../../lib/http.js';
import { buildPageMeta, readPagination, readSort } from '../../lib/pagination.js';
import { validate } from '../../validation/index.js';
import {
  CATEGORY_KINDS,
  TRANSACTION_KINDS,
  TRANSACTION_SORTS,
  TRANSACTION_STATUSES,
  categoryCreateSchema,
  categoryUpdateSchema,
  toCategoryRow,
  toCategoryView,
  toTransactionListView,
  toTransactionRow,
  toTransactionView,
  transactionCreateSchema,
  transactionStatusSchema,
  transactionUpdateSchema,
} from '../../validation/finance.schemas.js';
import { validationFailed } from '../../lib/errors.js';
import { assertPermissionIn } from '../middleware/auth.js';
import { resolveBranchId } from '../branch.js';

/**
 * Which status changes exist, where each may come from, and the permission it
 * needs. The from-lists mirror the database state machine; the permissions mirror
 * the seed. `approved` carries the extra self-approval rule, applied in the
 * handler because it depends on who submitted.
 */
const STATUS_RULES = Object.freeze({
  pending_approval: { from: ['draft', 'rejected'], permission: 'finance.submit' },
  approved: { from: ['pending_approval'], permission: 'finance.approve' },
  rejected: { from: ['pending_approval'], permission: 'finance.reject' },
  void: { from: ['approved'], permission: 'finance.void' },
  draft: { from: ['rejected'], permission: 'finance.update' },
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

function readDate(query, name) {
  const value = query.get(name)?.trim();
  if (!value) return undefined;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationFailed('That date filter is not a date.', {
      details: { fields: { [name]: 'Use an ISO date, for example 2026-09-01.' } },
    });
  }
  return value;
}

/** Which audit action each status transition writes. */
const STATUS_AUDIT = Object.freeze({
  pending_approval: 'transaction.submitted',
  approved: 'transaction.approved',
  rejected: 'transaction.rejected',
  void: 'transaction.voided',
  draft: 'transaction.reopened',
});

export function registerFinanceRoutes(router, { finance, audit }) {
  /* ---- categories ------------------------------------------------------- */

  async function listCategories(context) {
    const rows = await finance.listCategories({
      accessToken: context.session.accessToken,
      kind: readEnum(context.query, 'kind', CATEGORY_KINDS),
      includeInactive: context.query.get('all') === '1',
    });

    return ok(rows.map(toCategoryView));
  }

  async function createCategory(context) {
    const input = validate(categoryCreateSchema, await context.json());
    const row = await finance.createCategory({
      accessToken: context.session.accessToken,
      row: toCategoryRow(input),
    });

    context.logger.info('transaction category created', { categoryId: row.id });
    return created(toCategoryView(row));
  }

  async function updateCategory(context) {
    const input = validate(categoryUpdateSchema, await context.json());
    const row = await finance.updateCategory({
      accessToken: context.session.accessToken,
      id: context.params.id,
      patch: toCategoryRow(input),
    });

    context.logger.info('transaction category updated', {
      categoryId: row.id,
      fields: Object.keys(input).sort(),
    });
    return ok(toCategoryView(row));
  }

  /* ---- list ------------------------------------------------------------- */

  async function list(context) {
    const pagination = readPagination(context.query);
    // A ledger reads most-recent-first, so default to descending by date when no
    // sort is asked for. An explicit `?sort=occurred` still gives ascending.
    const sort = readSort(context.query.get('sort') ?? '-occurred', TRANSACTION_SORTS, 'occurred');

    const { rows, total } = await finance.list({
      accessToken: context.session.accessToken,
      branchId: context.query.get('branchId') || undefined,
      kind: readEnum(context.query, 'kind', TRANSACTION_KINDS),
      status: readEnum(context.query, 'status', TRANSACTION_STATUSES),
      categoryId: context.query.get('categoryId') || undefined,
      memberId: context.query.get('memberId') || undefined,
      from: readDate(context.query, 'from'),
      to: readDate(context.query, 'to'),
      search: context.query.get('search')?.trim() || undefined,
      sort,
      pagination,
    });

    return ok(rows.map(toTransactionListView), {
      ...buildPageMeta({ page: pagination.page, pageSize: pagination.pageSize, total }),
      sort: sort.key,
      ascending: sort.ascending,
    });
  }

  /* ---- create ----------------------------------------------------------- */

  async function create(context) {
    const payload = await context.json();
    const input = validate(transactionCreateSchema, {
      ...payload,
      branchId: resolveBranchId(context, payload?.branchId),
    });

    const { accessToken } = context.session;
    assertPermissionIn(context, 'finance.create', input.branchId);

    // Currency is the church's, not the client's, and the read fails loudly if it
    // has not been configured. Born a draft: submitting is a separate act.
    const currency = await finance.getCurrency({ accessToken });

    const row = await finance.create({
      accessToken,
      row: { ...toTransactionRow(input), currency, status: 'draft' },
    });

    context.logger.info('transaction created', {
      transactionId: row.id,
      kind: row.kind,
      branchId: row.branch_id,
    });
    await audit.record(context, {
      action: 'transaction.created',
      resourceType: 'transaction',
      resourceId: row.id,
      branchId: row.branch_id,
      changes: { kind: row.kind },
    });

    return created(toTransactionView(row), { location: `/api/transactions/${row.id}` });
  }

  /* ---- read ------------------------------------------------------------- */

  function capabilities(context, txn) {
    const branch = txn.branch_id;
    const editable = ['draft', 'rejected'].includes(txn.status);
    const iSubmitted = txn.submitted_by === context.session.userId;

    return {
      canEdit: editable && context.can('finance.update', branch),
      canSubmit: editable && context.can('finance.submit', branch),
      // The second signature: the submitter cannot also approve.
      canApprove:
        txn.status === 'pending_approval' && context.can('finance.approve', branch) && !iSubmitted,
      canReject: txn.status === 'pending_approval' && context.can('finance.reject', branch),
      canVoid: txn.status === 'approved' && context.can('finance.void', branch),
    };
  }

  async function read(context) {
    const txn = await finance.get({
      accessToken: context.session.accessToken,
      id: context.params.id,
    });

    return ok({ ...toTransactionView(txn), ...capabilities(context, txn) });
  }

  /* ---- update ----------------------------------------------------------- */

  async function update(context) {
    const input = validate(transactionUpdateSchema, await context.json());
    const { accessToken } = context.session;

    const txn = await finance.get({ accessToken, id: context.params.id });
    assertPermissionIn(context, 'finance.update', txn.branch_id);

    // The database freezes financial fields once a transaction leaves
    // draft/rejected. We give a clear message here rather than waiting for the
    // trigger, but the trigger is what makes it true.
    if (!['draft', 'rejected'].includes(txn.status)) {
      throw conflict(
        `This transaction is ${txn.status} and its details are locked. Reject it first to make a correction.`,
      );
    }

    const row = await finance.update({
      accessToken,
      id: txn.id,
      patch: toTransactionRow(input),
    });

    context.logger.info('transaction updated', {
      transactionId: row.id,
      fields: Object.keys(input).sort(),
    });

    return ok(toTransactionView(row));
  }

  /* ---- lifecycle -------------------------------------------------------- */

  async function changeStatus(context) {
    const { status, reason } = validate(transactionStatusSchema, await context.json());
    const { accessToken } = context.session;

    const txn = await finance.get({ accessToken, id: context.params.id });

    if (txn.status === status) {
      throw conflict(`This transaction is already ${status}.`);
    }

    const rule = STATUS_RULES[status];
    if (!rule.from.includes(txn.status)) {
      throw conflict(`A transaction cannot go from ${txn.status} to ${status}.`);
    }

    assertPermissionIn(context, rule.permission, txn.branch_id);

    // The second signature. The DB constraint is the real guard; this is the
    // legible refusal before the round trip.
    if (status === 'approved' && txn.submitted_by === context.session.userId) {
      context.logger.warn('self-approval refused', { transactionId: txn.id });
      throw forbidden('You cannot approve a transaction you submitted. It needs a second person.');
    }

    const row = await finance.changeStatus({ accessToken, id: txn.id, status, reason });

    context.logger.info('transaction status changed', {
      transactionId: row.id,
      from: txn.status,
      to: status,
    });
    await audit.record(context, {
      action: STATUS_AUDIT[status],
      resourceType: 'transaction',
      resourceId: row.id,
      branchId: row.branch_id,
      changes: { from: txn.status, to: status },
    });

    return ok(toTransactionView(row));
  }

  /* ---- registration ----------------------------------------------------- */

  router.get('/transaction-categories', listCategories, { permission: 'finance.view' });
  router.post('/transaction-categories', createCategory, {
    permission: 'finance.categories.manage',
  });
  router.patch('/transaction-categories/:id', updateCategory, {
    permission: 'finance.categories.manage',
  });

  router.get('/transactions', list, { permission: 'finance.view' });
  router.post('/transactions', create, { permission: 'finance.create' });
  router.get('/transactions/:id', read, { permission: 'finance.view' });
  router.patch('/transactions/:id', update, { permission: 'finance.update' });
  // The declared permission is the loosest finance actor that legitimately reaches
  // this endpoint; the real per-transition gating is in the handler above. This
  // mirrors the events publish split — see the module comment.
  router.post('/transactions/:id/status', changeStatus, { permission: 'finance.view' });
}
