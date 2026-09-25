/**
 * Transaction-shaped fixtures.
 */

import { BRANCH_MAIN } from './auth-fixtures.js';

export const TRANSACTION_ID = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const CATEGORY_INCOME_ID = 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const CATEGORY_EXPENSE_ID = 'ccccccc1-cccc-4ccc-8ccc-cccccccccccc';
export const MEMBER_ID = '11111111-1111-4111-8111-111111111111';

/** Who submitted the fixture transaction, for the self-approval tests. */
export const SUBMITTER_ID = 'user-12';

export function transactionRow(overrides = {}) {
  const { transaction_categories, members, ...rest } = overrides;

  return {
    id: TRANSACTION_ID,
    branch_id: BRANCH_MAIN,
    kind: 'income',
    category_id: CATEGORY_INCOME_ID,
    income_type: 'tithe',
    member_id: MEMBER_ID,
    amount: '150.00',
    currency: 'GHS',
    occurred_on: '2026-09-06',
    payment_method: 'cash',
    reference: null,
    description: 'Sunday tithe',
    receipt_path: null,
    status: 'draft',
    recorded_by: SUBMITTER_ID,
    submitted_by: null,
    submitted_at: null,
    approved_by: null,
    approved_at: null,
    rejected_by: null,
    rejected_at: null,
    rejection_reason: null,
    voided_by: null,
    voided_at: null,
    void_reason: null,
    created_at: '2026-09-06T10:00:00.000Z',
    updated_at: '2026-09-06T10:00:00.000Z',
    transaction_categories:
      transaction_categories === null
        ? null
        : { name: 'Tithes', kind: 'income', code: 'TITHE', ...transaction_categories },
    members:
      members === null ? null : { member_no: 'MAIN-000101', full_name: 'Grace Mensah', ...members },
    ...rest,
  };
}

/** A transaction submitted by SUBMITTER_ID and now waiting for approval. */
export function pendingTransactionRow(overrides = {}) {
  return transactionRow({
    status: 'pending_approval',
    submitted_by: SUBMITTER_ID,
    submitted_at: '2026-09-06T11:00:00.000Z',
    ...overrides,
  });
}

/** An anonymous offering: income with no member. */
export function anonymousTransactionRow(overrides = {}) {
  return transactionRow({
    income_type: 'offering',
    member_id: null,
    members: null,
    description: 'Loose offering',
    ...overrides,
  });
}

export function expenseTransactionRow(overrides = {}) {
  return transactionRow({
    kind: 'expense',
    category_id: CATEGORY_EXPENSE_ID,
    income_type: null,
    member_id: null,
    members: null,
    description: 'Generator fuel',
    transaction_categories: { name: 'Utilities', kind: 'expense', code: 'UTIL' },
    ...overrides,
  });
}

export function transactionListRow(overrides = {}) {
  return {
    id: TRANSACTION_ID,
    kind: 'income',
    category_id: CATEGORY_INCOME_ID,
    income_type: 'tithe',
    member_id: MEMBER_ID,
    amount: '150.00',
    currency: 'GHS',
    occurred_on: '2026-09-06',
    payment_method: 'cash',
    reference: null,
    status: 'approved',
    transaction_categories: { name: 'Tithes' },
    members: { full_name: 'Grace Mensah' },
    ...overrides,
  };
}

export function incomeCategoryRow(overrides = {}) {
  return {
    id: CATEGORY_INCOME_ID,
    kind: 'income',
    name: 'Tithes',
    code: 'TITHE',
    description: null,
    is_active: true,
    sort_order: 10,
    ...overrides,
  };
}

export function expenseCategoryRow(overrides = {}) {
  return {
    id: CATEGORY_EXPENSE_ID,
    kind: 'expense',
    name: 'Utilities',
    code: 'UTIL',
    description: null,
    is_active: true,
    sort_order: 20,
    ...overrides,
  };
}

/** The finance.currency settings row, as the service reads it. */
export function currencySettingRow(value = 'GHS') {
  return { value };
}

export function transactionPayload(overrides = {}) {
  return {
    kind: 'income',
    categoryId: CATEGORY_INCOME_ID,
    incomeType: 'offering',
    amount: '200.00',
    occurredOn: '2026-09-13',
    paymentMethod: 'cash',
    ...overrides,
  };
}
