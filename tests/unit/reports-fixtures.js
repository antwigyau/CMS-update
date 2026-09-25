/**
 * Rows shaped like the reporting reads, for the report tests.
 *
 * Each builder matches the columns and embeds its service query selects, so the
 * aggregation tests reduce realistic shapes and the route tests can hand the
 * query recorder something the summariser will accept.
 */

export function financeRow(overrides = {}) {
  return {
    id: 'txn-1',
    kind: 'income',
    income_type: 'tithe',
    amount: '100.00',
    currency: 'GHS',
    occurred_on: '2026-09-01',
    payment_method: 'cash',
    reference: 'SVC-01',
    category_id: 'cat-income',
    transaction_categories: { name: 'Tithes' },
    members: { full_name: 'Ama Mensah' },
    ...overrides,
  };
}

/** A small, hand-checkable ledger: 100 + 50 tithe/offering income, 30 expense. */
export function financeRows() {
  return [
    financeRow({ id: 't1', income_type: 'tithe', amount: '100.00' }),
    financeRow({
      id: 't2',
      income_type: 'offering',
      amount: '50.00',
      transaction_categories: { name: 'Offerings' },
      category_id: 'cat-offering',
    }),
    financeRow({
      id: 't3',
      kind: 'expense',
      income_type: null,
      amount: '30.00',
      transaction_categories: { name: 'Utilities' },
      category_id: 'cat-utilities',
      members: null,
    }),
  ];
}

export function memberRow(overrides = {}) {
  return {
    id: 'mem-1',
    member_no: 'MAIN-000001',
    full_name: 'Ama Mensah',
    membership_status: 'active',
    gender: 'female',
    is_baptized: true,
    date_joined: '2026-01-15',
    phone: '+233201234567',
    email: 'ama@example.test',
    ...overrides,
  };
}

export function memberRows() {
  return [
    memberRow({ id: 'm1', membership_status: 'active', gender: 'female', is_baptized: true }),
    memberRow({ id: 'm2', membership_status: 'active', gender: 'male', is_baptized: false }),
    memberRow({ id: 'm3', membership_status: 'new', gender: 'male', is_baptized: false }),
  ];
}

export function attendanceRow(overrides = {}) {
  return {
    id: 'ses-1',
    session_date: '2026-09-06',
    title: 'Sunday Service',
    session_type: 'service',
    status: 'closed',
    count_total: 200,
    ...overrides,
  };
}

export function attendanceRows() {
  return [
    attendanceRow({ id: 's1', session_type: 'service', count_total: 200 }),
    attendanceRow({ id: 's2', session_type: 'service', count_total: 180 }),
    attendanceRow({ id: 's3', session_type: 'ministry', title: 'Choir', count_total: 20 }),
  ];
}

export function ministryRow(overrides = {}) {
  return {
    ministry_id: 'min-choir',
    role_in_ministry: 'member',
    joined_on: '2026-02-01',
    ministries: { name: 'Choir' },
    members: { full_name: 'Ama Mensah' },
    ...overrides,
  };
}

export function ministryRows() {
  return [
    ministryRow({ ministry_id: 'min-choir', ministries: { name: 'Choir' } }),
    ministryRow({
      ministry_id: 'min-choir',
      ministries: { name: 'Choir' },
      members: { full_name: 'Kojo Owusu' },
      role_in_ministry: 'leader',
    }),
    ministryRow({
      ministry_id: 'min-ushers',
      ministries: { name: 'Ushers' },
      members: { full_name: 'Efua Sarpong' },
    }),
  ];
}

export function eventRow(overrides = {}) {
  return {
    id: 'evt-1',
    title: 'Harvest',
    starts_at: '2026-09-20T09:00:00Z',
    status: 'published',
    capacity: 300,
    event_registrations: [{ count: 42 }],
    ...overrides,
  };
}

export function eventRows() {
  return [
    eventRow({ id: 'e1', status: 'published', event_registrations: [{ count: 42 }] }),
    eventRow({ id: 'e2', status: 'draft', event_registrations: [{ count: 0 }] }),
  ];
}
