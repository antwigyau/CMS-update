/**
 * Reporting endpoints.
 *
 * Three things are worth proving here and are easy to get wrong:
 *
 *   1. Every report is capped. The service asks for an exact count and refuses a
 *      window wider than REPORT_ROW_CAP rather than streaming it — the phase's
 *      definition of done ("no report loads unbounded rows").
 *   2. The arithmetic. The summaries are pure reductions, so they are checked
 *      against hand-totalled fixtures, including that money does not drift.
 *   3. The gate. A report is behind its own `reports.*` permission, separate from
 *      the feature's operational permissions — 'user-14' may read the finance
 *      report but holds no finance.* write permission at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config/env.js';
import { buildRouter, handleRequest } from '../../src/server/app.js';
import { createReportsService, REPORT_ROW_CAP } from '../../src/services/reports.service.js';
import { createRateLimiter } from '../../src/server/middleware/rate-limit.js';
import {
  summariseAttendance,
  summariseEvents,
  summariseFinance,
  summariseMembers,
  summariseMinistries,
} from '../../src/lib/reports.js';
import {
  FIXTURES,
  createFakeIdentityLoader,
  createFakeProvider,
  mintToken,
} from './auth-fixtures.js';
import {
  attendanceRows,
  eventRows,
  financeRows,
  memberRows,
  ministryRows,
} from './reports-fixtures.js';
import { createQueryRecorder } from './query-recorder.js';

const cfg = loadConfig({ APP_URL: 'http://localhost:3000' });

/** 'user-14' holds every reports.* view; 'user-2' holds none. */
function createClient({ as = 'user-14', ...recorderOptions } = {}) {
  const recorder = createQueryRecorder(recorderOptions);
  const { provider } = createFakeProvider({ accounts: FIXTURES.accounts });

  const router = buildRouter({
    cfg,
    provider,
    loadIdentity: createFakeIdentityLoader(FIXTURES.profiles),
    rateLimiter: createRateLimiter(),
    reports: createReportsService({ getClient: recorder.getClient }),
  });

  const token = mintToken({ sub: as });
  const csrf = 'e'.repeat(64);

  async function call(path) {
    return handleRequest(
      new Request(`http://localhost:3000${path}`, {
        method: 'GET',
        headers: {
          'sec-fetch-site': 'same-origin',
          cookie: `cma_at=${token}; cma_csrf=${csrf}`,
        },
      }),
      { router, sink: () => {} },
    );
  }

  return { call, recorder };
}

/* -------------------------------------------------------------------------- */

describe('the reports route table', () => {
  const routes = buildRouter({
    cfg,
    provider: createFakeProvider({}).provider,
    loadIdentity: createFakeIdentityLoader({}),
    reports: createReportsService({ getClient: createQueryRecorder().getClient }),
  })
    .list()
    .filter((route) => route.pattern.startsWith('/reports'));

  it('registers ten GET routes, none public', () => {
    assert.equal(routes.length, 10);
    for (const route of routes) {
      assert.equal(route.method, 'GET');
      assert.equal(route.isPublic, false);
      assert.ok(route.permission);
    }
  });

  it('gates each domain on its own reports.* permission', () => {
    const permissionOf = (pattern) => routes.find((route) => route.pattern === pattern)?.permission;

    assert.equal(permissionOf('/reports/finance/summary'), 'reports.finance.view');
    assert.equal(permissionOf('/reports/finance/export'), 'reports.finance.view');
    assert.equal(permissionOf('/reports/members/summary'), 'reports.members.view');
    assert.equal(permissionOf('/reports/attendance/summary'), 'reports.attendance.view');
    assert.equal(permissionOf('/reports/ministries/summary'), 'reports.ministry.view');
    assert.equal(permissionOf('/reports/events/summary'), 'reports.event.view');
  });

  it('exposes no write or delete route — reporting is read-only', () => {
    for (const route of routes) assert.equal(route.method, 'GET');
  });
});

/* ---- aggregation (pure) -------------------------------------------------- */

describe('summariseFinance', () => {
  it('totals income, expense, and the net over approved rows', () => {
    const summary = summariseFinance(financeRows());
    assert.equal(summary.count, 3);
    assert.equal(summary.totalIncome, 150);
    assert.equal(summary.totalExpense, 30);
    assert.equal(summary.net, 120);
    assert.equal(summary.currency, 'GHS');
  });

  it('breaks income down by type and everything by category', () => {
    const summary = summariseFinance(financeRows());
    assert.equal(summary.byIncomeType.tithe, 100);
    assert.equal(summary.byIncomeType.offering, 50);
    assert.equal(summary.byIncomeType.expense, undefined);
    const utilities = summary.byCategory.find((row) => row.category === 'Utilities');
    assert.equal(utilities.kind, 'expense');
    assert.equal(utilities.total, 30);
  });

  it('sums money without float drift', () => {
    const rows = [
      { kind: 'income', income_type: 'tithe', amount: '0.10', transaction_categories: null },
      { kind: 'income', income_type: 'tithe', amount: '0.20', transaction_categories: null },
    ];
    assert.equal(summariseFinance(rows).totalIncome, 0.3);
  });
});

describe('summariseMembers / attendance / ministries / events', () => {
  it('counts members by status and gender, and the baptised', () => {
    const summary = summariseMembers(memberRows());
    assert.equal(summary.count, 3);
    assert.equal(summary.baptised, 1);
    assert.equal(summary.byStatus.active, 2);
    assert.equal(summary.byStatus.new, 1);
    assert.equal(summary.byGender.male, 2);
    assert.equal(summary.byGender.female, 1);
  });

  it('sums attendance headcount and averages it per session', () => {
    const summary = summariseAttendance(attendanceRows());
    assert.equal(summary.sessions, 3);
    assert.equal(summary.totalHeadcount, 400);
    assert.equal(summary.averageHeadcount, 133);
    assert.equal(summary.byType.service.sessions, 2);
    assert.equal(summary.byType.service.headcount, 380);
  });

  it('counts active memberships per ministry', () => {
    const summary = summariseMinistries(ministryRows());
    assert.equal(summary.ministries, 2);
    assert.equal(summary.totalMemberships, 3);
    assert.equal(summary.perMinistry[0].members, 2); // Choir, sorted first
  });

  it('counts events by status and totals registrations', () => {
    const summary = summariseEvents(eventRows());
    assert.equal(summary.count, 2);
    assert.equal(summary.byStatus.published, 1);
    assert.equal(summary.byStatus.draft, 1);
    assert.equal(summary.totalRegistrations, 42);
  });
});

/* ---- service query shape ------------------------------------------------- */

describe('the reports service', () => {
  it('reads only approved transactions, filtered and capped, for finance', async () => {
    const recorder = createQueryRecorder({ rows: financeRows(), count: 3 });
    const reports = createReportsService({ getClient: recorder.getClient });

    await reports.fetchFinance({
      accessToken: 't',
      kind: 'income',
      from: '2026-09-01',
      to: '2026-09-30',
    });

    assert.ok(recorder.tables().includes('transactions'));
    const eqs = recorder.allArgsFor('eq');
    assert.ok(eqs.some(([col, val]) => col === 'status' && val === 'approved'));
    assert.ok(eqs.some(([col, val]) => col === 'kind' && val === 'income'));
    assert.deepEqual(recorder.argsFor('gte'), ['occurred_on', '2026-09-01']);
    assert.deepEqual(recorder.argsFor('lte'), ['occurred_on', '2026-09-30']);
    assert.deepEqual(recorder.argsFor('range'), [0, REPORT_ROW_CAP - 1]);
    assert.deepEqual(recorder.argsFor('select')[1], { count: 'exact' });
  });

  it('reads only live members and filters by joined-date window', async () => {
    const recorder = createQueryRecorder({ rows: memberRows(), count: 3 });
    const reports = createReportsService({ getClient: recorder.getClient });

    await reports.fetchMembers({ accessToken: 't', joinedFrom: '2026-01-01' });

    assert.ok(recorder.tables().includes('members'));
    assert.deepEqual(recorder.argsFor('is'), ['deleted_at', null]);
    assert.deepEqual(recorder.argsFor('gte'), ['date_joined', '2026-01-01']);
  });

  it('reads only active memberships for the ministry report', async () => {
    const recorder = createQueryRecorder({ rows: ministryRows(), count: 3 });
    const reports = createReportsService({ getClient: recorder.getClient });

    await reports.fetchMinistries({ accessToken: 't' });

    assert.ok(recorder.tables().includes('ministry_members'));
    assert.deepEqual(recorder.argsFor('is'), ['left_on', null]);
  });

  it('refuses a window wider than the cap rather than truncating it', async () => {
    const recorder = createQueryRecorder({ rows: financeRows(), count: REPORT_ROW_CAP + 1 });
    const reports = createReportsService({ getClient: recorder.getClient });

    await assert.rejects(
      () => reports.fetchFinance({ accessToken: 't' }),
      (error) => error.status === 409 && /narrow/i.test(error.message),
    );
  });
});

/* ---- routes -------------------------------------------------------------- */

describe('GET /api/reports/*/summary', () => {
  it('returns the aggregated finance summary to a permitted caller', async () => {
    const { call } = createClient({
      perTable: { transactions: { rows: financeRows(), count: 3 } },
    });
    const response = await call('/api/reports/finance/summary');
    assert.equal(response.status, 200);

    const { data } = await response.json();
    assert.equal(data.totalIncome, 150);
    assert.equal(data.net, 120);
  });

  it('refuses a caller without the report permission', async () => {
    const { call } = createClient({ as: 'user-2', rows: [], count: 0 });
    const response = await call('/api/reports/finance/summary');
    assert.equal(response.status, 403);
  });

  it('rejects a filter that is not a date', async () => {
    const { call } = createClient({ rows: [], count: 0 });
    const response = await call('/api/reports/finance/summary?from=last-week');
    assert.equal(response.status, 422);
  });

  it('refuses an over-large window with a 409', async () => {
    const { call } = createClient({
      perTable: { transactions: { rows: financeRows(), count: REPORT_ROW_CAP + 1 } },
    });
    const response = await call('/api/reports/finance/summary');
    assert.equal(response.status, 409);
  });
});

describe('GET /api/reports/*/export', () => {
  it('returns a CSV attachment with the report rows', async () => {
    const { call } = createClient({
      perTable: { transactions: { rows: financeRows(), count: 3 } },
    });
    const response = await call('/api/reports/finance/export');

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv/);
    assert.match(
      response.headers.get('content-disposition'),
      /attachment; filename="finance-report-/,
    );

    const body = await response.text();
    assert.ok(body.startsWith('Date,Kind,Income type,Category,Member,Amount,Currency'));
    assert.ok(body.includes('Tithes'));
  });

  it('is gated on the same permission as the summary', async () => {
    const { call } = createClient({ as: 'user-2', rows: [], count: 0 });
    const response = await call('/api/reports/finance/export');
    assert.equal(response.status, 403);
  });
});
