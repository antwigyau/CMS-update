/**
 * Finance endpoints.
 *
 * The distinctive concern here is the two-signature rule: recording and submitting
 * a transaction is a different permission from approving it, and the person who
 * submitted may never be the person who approves. The database owns that rule
 * (`transactions_no_self_approval`); these tests prove the API mirrors it as a
 * clean 403 and a `canApprove` flag rather than leaving it to a raw constraint
 * error.
 *
 * The other concern is currency: it is the church's, read from settings and
 * stamped server-side, never taken from the request. A create refuses loudly if it
 * has not been configured.
 *
 * The fixtures make the split concrete: 'user-12' records and submits but cannot
 * approve; 'user-13' approves, rejects, and voids but cannot record.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createFinanceService } from '../../src/services/finance.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import {
  BRANCH_MAIN,
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import {
  CATEGORY_INCOME_ID,
  MEMBER_ID,
  TRANSACTION_ID,
  anonymousTransactionRow,
  currencySettingRow,
  expenseTransactionRow,
  incomeCategoryRow,
  pendingTransactionRow,
  transactionListRow,
  transactionPayload,
  transactionRow,
} from './finance-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });

/** 'user-12' records and submits; 'user-13' approves; default to the officer. */
function createClient({ as = 'user-12', ...recorderOptions } = {}) {
  const recorder = createQueryRecorder(recorderOptions);
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    finance: createFinanceService({ getClient: recorder.getClient }),
  });

  const token = mintToken({ sub: as });
  const csrf = 'e'.repeat(64);

  async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const requestHeaders = {
      'sec-fetch-site': 'same-origin',
      cookie: `cma_at=${token}; cma_csrf=${csrf}`,
      'x-csrf-token': csrf,
      ...headers,
    };
    for (const [name, value] of Object.entries(requestHeaders)) {
      if (value === null) delete requestHeaders[name];
    }
    if (body !== undefined) requestHeaders['content-type'] = 'application/json';

    return handleRequest(
      new Request(`http://localhost:3000${path}`, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { router, sink: () => {} },
    );
  }

  return { call, recorder };
}

/**
 * A create needs both the transaction insert and the currency read to resolve, so
 * seed the settings table alongside the transactions table.
 */
const withCurrency = (transaction = transactionRow(), currency = 'GHS') => ({
  perTable: {
    transactions: { rows: [transaction] },
    settings: { rows: [currencySettingRow(currency)] },
  },
});

const withTransaction = (transaction = transactionRow()) => ({
  perTable: { transactions: { rows: [transaction] } },
});

/* -------------------------------------------------------------------------- */

describe('the finance route table', () => {
  const routes = buildRouter({
    cfg,
    provider: createFakeProvider({}).provider,
    loadIdentity: createFakeIdentityLoader({}),
    finance: createFinanceService({ getClient: createQueryRecorder().getClient }),
  })
    .list()
    .filter((route) => route.pattern.startsWith('/transaction'));

  it('registers eight routes, none public', () => {
    assert.equal(routes.length, 8);
    for (const route of routes) {
      assert.equal(route.isPublic, false);
      assert.ok(route.permission);
    }
  });

  it('has no delete route: a transaction is voided, never deleted', () => {
    assert.equal(
      routes.some((route) => route.method === 'DELETE'),
      false,
    );
  });

  it('puts the lifecycle on its own endpoint, so status is never a field edit', () => {
    assert.ok(routes.some((route) => route.pattern === '/transactions/:id/status'));
  });

  it('gates category writes on the categories permission', () => {
    const writes = routes.filter(
      (route) => route.pattern.startsWith('/transaction-categories') && route.method !== 'GET',
    );
    assert.equal(writes.length, 2);
    for (const route of writes) {
      assert.equal(route.permission, 'finance.categories.manage');
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('GET /api/transaction-categories', () => {
  it('returns the active vocabulary', async () => {
    const client = createClient({ rows: [incomeCategoryRow()] });
    const response = await client.call('/api/transaction-categories');

    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data[0].name, 'Tithes');
    assert.equal(data[0].kind, 'income');
    assert.deepEqual(client.recorder.argsFor('eq'), ['is_active', true]);
  });

  it('filters by kind', async () => {
    const client = createClient({ rows: [incomeCategoryRow()] });
    await client.call('/api/transaction-categories?kind=income');

    assert.deepEqual(client.recorder.allArgsFor('eq'), [
      ['kind', 'income'],
      ['is_active', true],
    ]);
  });

  it('includes retired categories only when asked', async () => {
    const client = createClient({ rows: [incomeCategoryRow({ is_active: false })] });
    await client.call('/api/transaction-categories?all=1');

    assert.equal(client.recorder.called('eq'), false);
  });

  it('refuses a caller without finance.view', async () => {
    const client = createClient({ as: 'user-2', rows: [] });
    assert.equal((await client.call('/api/transaction-categories')).status, 403);
  });
});

describe('POST /api/transaction-categories', () => {
  it('needs finance.categories.manage', async () => {
    const client = createClient({ as: 'user-13', rows: [incomeCategoryRow()] });
    const response = await client.call('/api/transaction-categories', {
      method: 'POST',
      body: { kind: 'income', name: 'Building Fund' },
    });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('creates a category', async () => {
    const client = createClient({ rows: [incomeCategoryRow({ name: 'Building Fund' })] });
    const response = await client.call('/api/transaction-categories', {
      method: 'POST',
      body: { kind: 'income', name: 'Building Fund', code: 'BUILD' },
    });

    assert.equal(response.status, 201);
    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.kind, 'income');
    assert.equal(row.name, 'Building Fund');
    assert.equal(row.code, 'BUILD');
  });
});

/* -------------------------------------------------------------------------- */

describe('GET /api/transactions', () => {
  it('refuses a caller without finance.view', async () => {
    const client = createClient({ as: 'user-2', rows: [] });
    assert.equal((await client.call('/api/transactions')).status, 403);
  });

  it('returns transactions with their category and member', async () => {
    const client = createClient({ rows: [transactionListRow()], count: 1 });
    const response = await client.call('/api/transactions');

    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data[0].categoryName, 'Tithes');
    assert.equal(data[0].memberName, 'Grace Mensah');
    assert.equal(data[0].amount, '150.00');
    assert.equal(data[0].currency, 'GHS');
  });

  it('orders by date descending, which is what a ledger wants', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/transactions');

    assert.deepEqual(client.recorder.allArgsFor('order'), [
      ['occurred_on', { ascending: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('filters by kind, status, category, and member', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call(
      `/api/transactions?kind=income&status=approved&categoryId=${CATEGORY_INCOME_ID}&memberId=${MEMBER_ID}`,
    );

    assert.deepEqual(client.recorder.allArgsFor('eq'), [
      ['kind', 'income'],
      ['status', 'approved'],
      ['category_id', CATEGORY_INCOME_ID],
      ['member_id', MEMBER_ID],
    ]);
  });

  it('filters by a date window on the occurred date', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/transactions?from=2026-09-01&to=2026-09-30');

    assert.deepEqual(client.recorder.argsFor('gte'), ['occurred_on', '2026-09-01']);
    assert.deepEqual(client.recorder.argsFor('lte'), ['occurred_on', '2026-09-30']);
  });

  it('rejects a status that is not real', async () => {
    const client = createClient({ rows: [], count: 0 });
    assert.equal((await client.call('/api/transactions?status=paid')).status, 422);
  });

  it('searches reference and description with wildcards escaped', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/transactions?search=%25fuel');

    const [pattern] = client.recorder.argsFor('or');
    assert.match(pattern, /reference\.ilike\.%\\%fuel%/);
    assert.match(pattern, /description\.ilike\.%\\%fuel%/);
  });

  it('caps the page size', async () => {
    const client = createClient({ rows: [], count: 0 });
    await client.call('/api/transactions?pageSize=9999');

    assert.deepEqual(client.recorder.argsFor('range'), [0, 99]);
  });
});

/* -------------------------------------------------------------------------- */

describe('POST /api/transactions', () => {
  it('records a transaction as a draft, stamped with the configured currency', async () => {
    const client = createClient({ ...withCurrency() });
    const response = await client.call('/api/transactions', {
      method: 'POST',
      body: transactionPayload(),
    });

    assert.equal(response.status, 201);
    const [row] = client.recorder.argsFor('insert');
    assert.equal(
      row.status,
      'draft',
      'a transaction is not submitted by the request that records it',
    );
    assert.equal(row.currency, 'GHS', 'currency is the church’s, stamped server-side');
    assert.equal(row.branch_id, BRANCH_MAIN);
  });

  it('refuses a currency supplied by the caller', async () => {
    const client = createClient({ ...withCurrency() });
    const response = await client.call('/api/transactions', {
      method: 'POST',
      body: transactionPayload({ currency: 'USD' }),
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('refuses a status supplied by the caller', async () => {
    const client = createClient({ ...withCurrency() });
    const response = await client.call('/api/transactions', {
      method: 'POST',
      body: transactionPayload({ status: 'approved' }),
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('fails loudly when no currency has been configured', async () => {
    const client = createClient({
      perTable: {
        transactions: { rows: [transactionRow()] },
        settings: { rows: [] },
      },
    });
    const response = await client.call('/api/transactions', {
      method: 'POST',
      body: transactionPayload(),
    });

    assert.equal(response.status, 409, 'a guessed currency is a silently wrong ledger');
    assert.equal(client.recorder.called('insert'), false);
  });

  it('allows an anonymous offering: income with no member', async () => {
    const client = createClient({ ...withCurrency(anonymousTransactionRow()) });
    const response = await client.call('/api/transactions', {
      method: 'POST',
      body: transactionPayload({ incomeType: 'offering', memberId: undefined }),
    });

    assert.equal(response.status, 201);
    const [row] = client.recorder.argsFor('insert');
    assert.equal(row.member_id, undefined, 'no member attributed');
  });

  it('requires an income type for income', async () => {
    const client = createClient({ ...withCurrency() });
    const response = await client.call('/api/transactions', {
      method: 'POST',
      body: transactionPayload({ incomeType: undefined }),
    });

    assert.equal(response.status, 422);
    assert.match((await response.json()).error.details.fields.incomeType, /kind of income/);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('refuses an income type on an expense', async () => {
    const client = createClient({ ...withCurrency(expenseTransactionRow()) });
    const response = await client.call('/api/transactions', {
      method: 'POST',
      body: transactionPayload({ kind: 'expense', incomeType: 'tithe' }),
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('refuses a member attributed to an expense', async () => {
    const client = createClient({ ...withCurrency(expenseTransactionRow()) });
    const response = await client.call('/api/transactions', {
      method: 'POST',
      body: transactionPayload({ kind: 'expense', incomeType: undefined, memberId: MEMBER_ID }),
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('refuses an amount with more than two decimal places rather than rounding it', async () => {
    const client = createClient({ ...withCurrency() });
    const response = await client.call('/api/transactions', {
      method: 'POST',
      body: transactionPayload({ amount: '19.999' }),
    });

    assert.equal(response.status, 422, 'a rounded amount is a wrong amount that looks right');
    assert.equal(client.recorder.called('insert'), false);
  });

  it('refuses a zero or negative amount', async () => {
    const client = createClient({ ...withCurrency() });
    assert.equal(
      (
        await client.call('/api/transactions', {
          method: 'POST',
          body: transactionPayload({ amount: '0' }),
        })
      ).status,
      422,
    );
  });

  it('refuses a future date', async () => {
    const client = createClient({ ...withCurrency() });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const response = await client.call('/api/transactions', {
      method: 'POST',
      body: transactionPayload({ occurredOn: tomorrow }),
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('insert'), false);
  });

  it('refuses a caller without finance.create', async () => {
    const client = createClient({ as: 'user-13', ...withCurrency() });
    const response = await client.call('/api/transactions', {
      method: 'POST',
      body: transactionPayload(),
    });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('insert'), false);
  });
});

/* -------------------------------------------------------------------------- */

describe('GET /api/transactions/:id', () => {
  it('returns the transaction with what the caller may do', async () => {
    const client = createClient({ ...withTransaction() });
    const response = await client.call(`/api/transactions/${TRANSACTION_ID}`);

    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.amount, '150.00');
    assert.equal(data.currency, 'GHS');
    assert.equal(data.canEdit, true, 'a draft is editable by the officer');
    assert.equal(data.canSubmit, true);
  });

  it('reports every capability the frontend renders a control for', async () => {
    const client = createClient({ ...withTransaction() });
    const { data } = await (await client.call(`/api/transactions/${TRANSACTION_ID}`)).json();

    for (const flag of ['canEdit', 'canSubmit', 'canApprove', 'canReject', 'canVoid']) {
      assert.equal(typeof data[flag], 'boolean', `${flag} must always be present`);
    }
  });

  it('offers no approval on a draft, whatever the caller holds', async () => {
    const client = createClient({ as: 'user-13', ...withTransaction() });
    const { data } = await (await client.call(`/api/transactions/${TRANSACTION_ID}`)).json();

    assert.equal(data.canApprove, false, 'a draft is not pending approval');
    assert.equal(data.canReject, false);
  });

  it('offers approval to an approver on a pending transaction they did not submit', async () => {
    const client = createClient({
      as: 'user-13',
      ...withTransaction(pendingTransactionRow()),
    });
    const { data } = await (await client.call(`/api/transactions/${TRANSACTION_ID}`)).json();

    assert.equal(data.canApprove, true);
    assert.equal(data.canReject, true);
  });

  it('withholds approval from the very person who submitted it', async () => {
    // A submitter who also held finance.approve would still be refused. We prove
    // the flag is false when submitted_by is the caller, whatever they hold.
    const client = createClient({
      as: 'user-13',
      ...withTransaction(pendingTransactionRow({ submitted_by: 'user-13' })),
    });
    const { data } = await (await client.call(`/api/transactions/${TRANSACTION_ID}`)).json();

    assert.equal(data.canApprove, false);
  });

  it('404s a transaction the caller cannot see', async () => {
    const client = createClient({ perTable: { transactions: { rows: [] } } });
    assert.equal((await client.call(`/api/transactions/${TRANSACTION_ID}`)).status, 404);
  });
});

/* -------------------------------------------------------------------------- */

describe('PATCH /api/transactions/:id', () => {
  it('lets the officer correct a draft', async () => {
    const client = createClient({ ...withTransaction() });
    const response = await client.call(`/api/transactions/${TRANSACTION_ID}`, {
      method: 'PATCH',
      body: { description: 'Sunday tithe, corrected' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [
      { description: 'Sunday tithe, corrected' },
    ]);
  });

  it('will not accept a status, so approval cannot happen through an edit', async () => {
    const client = createClient({ ...withTransaction() });
    const response = await client.call(`/api/transactions/${TRANSACTION_ID}`, {
      method: 'PATCH',
      body: { status: 'approved' },
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('update'), false);
  });

  it('refuses to edit a transaction that is no longer a draft or rejected', async () => {
    const client = createClient({ ...withTransaction(pendingTransactionRow()) });
    const response = await client.call(`/api/transactions/${TRANSACTION_ID}`, {
      method: 'PATCH',
      body: { amount: '200.00' },
    });

    assert.equal(response.status, 409, 'financial fields are frozen once submitted');
    assert.equal(client.recorder.called('update'), false);
  });
});

/* -------------------------------------------------------------------------- */
/* The lifecycle and the two-signature rule                                   */
/* -------------------------------------------------------------------------- */

describe('POST /api/transactions/:id/status', () => {
  it('submits a draft for approval', async () => {
    const client = createClient({ ...withTransaction() });
    const response = await client.call(`/api/transactions/${TRANSACTION_ID}/status`, {
      method: 'POST',
      body: { status: 'pending_approval' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [{ status: 'pending_approval' }]);
  });

  it('lets an approver approve a pending transaction they did not submit', async () => {
    const client = createClient({ as: 'user-13', ...withTransaction(pendingTransactionRow()) });
    const response = await client.call(`/api/transactions/${TRANSACTION_ID}/status`, {
      method: 'POST',
      body: { status: 'approved' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [{ status: 'approved' }]);
  });

  it('refuses to let the submitter approve their own transaction', async () => {
    // An approver who also submitted it is refused: the second signature must be a
    // second person, even for someone holding finance.approve.
    const client = createClient({
      as: 'user-13',
      ...withTransaction(pendingTransactionRow({ submitted_by: 'user-13' })),
    });
    const response = await client.call(`/api/transactions/${TRANSACTION_ID}/status`, {
      method: 'POST',
      body: { status: 'approved' },
    });

    assert.equal(response.status, 403, 'the second signature must be a second person');
    assert.equal(client.recorder.called('update'), false);
  });

  it('refuses to approve for a caller who may only submit', async () => {
    const client = createClient({ as: 'user-12', ...withTransaction(pendingTransactionRow()) });
    const response = await client.call(`/api/transactions/${TRANSACTION_ID}/status`, {
      method: 'POST',
      body: { status: 'approved' },
    });

    assert.equal(response.status, 403);
    assert.equal(client.recorder.called('update'), false);
  });

  it('requires a reason to reject', async () => {
    const client = createClient({ as: 'user-13', ...withTransaction(pendingTransactionRow()) });
    const response = await client.call(`/api/transactions/${TRANSACTION_ID}/status`, {
      method: 'POST',
      body: { status: 'rejected' },
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('update'), false);
  });

  it('carries the reason onto the rejection', async () => {
    const client = createClient({ as: 'user-13', ...withTransaction(pendingTransactionRow()) });
    const response = await client.call(`/api/transactions/${TRANSACTION_ID}/status`, {
      method: 'POST',
      body: { status: 'rejected', reason: 'Wrong category' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(client.recorder.argsFor('update'), [
      { status: 'rejected', rejection_reason: 'Wrong category' },
    ]);
  });

  it('requires a reason to void', async () => {
    const client = createClient({
      as: 'user-13',
      ...withTransaction(transactionRow({ status: 'approved' })),
    });
    const response = await client.call(`/api/transactions/${TRANSACTION_ID}/status`, {
      method: 'POST',
      body: { status: 'void' },
    });

    assert.equal(response.status, 422);
    assert.equal(client.recorder.called('update'), false);
  });

  it('rejects a transition the state machine forbids', async () => {
    const client = createClient({
      as: 'user-13',
      ...withTransaction(transactionRow({ status: 'approved' })),
    });
    const response = await client.call(`/api/transactions/${TRANSACTION_ID}/status`, {
      method: 'POST',
      body: { status: 'pending_approval' },
    });

    assert.equal(response.status, 409);
    assert.equal(client.recorder.called('update'), false);
  });

  it('rejects a no-op transition to the same status', async () => {
    const client = createClient({ ...withTransaction() });
    const response = await client.call(`/api/transactions/${TRANSACTION_ID}/status`, {
      method: 'POST',
      body: { status: 'draft' },
    });

    assert.equal(response.status, 409);
    assert.equal(client.recorder.called('update'), false);
  });
});
