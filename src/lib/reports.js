/**
 * Report aggregation — pure functions over rows the service has already read.
 *
 * Kept separate from the data access on purpose: the service does the
 * RLS-scoped, row-capped read (so a report can never load an unbounded set), and
 * everything here is a deterministic reduction of that result. That split is what
 * makes the arithmetic testable without a database — the summaries below are
 * exercised with fixture rows in tests/unit/reports.test.js.
 *
 * Money is summed in integer minor units (pesewas for GHS) and only divided back
 * at the end, so a column of `numeric(14,2)` values never accumulates the float
 * drift that `0.1 + 0.2` is the famous example of.
 */

/** Whole minor units, e.g. "100.50" -> 10050. Anything unparseable is 0. */
function toMinorUnits(amount) {
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function fromMinorUnits(total) {
  return Math.round(total) / 100;
}

/* ---- finance (income + expense, approved only) ------------------------- */

export function summariseFinance(rows) {
  let income = 0;
  let expense = 0;
  const byIncomeType = {};
  const byCategory = new Map();

  for (const row of rows) {
    const minor = toMinorUnits(row.amount);

    if (row.kind === 'expense') expense += minor;
    else {
      income += minor;
      const type = row.income_type ?? 'other';
      byIncomeType[type] = (byIncomeType[type] ?? 0) + minor;
    }

    const name = row.transaction_categories?.name ?? '—';
    const key = `${row.kind}:${name}`;
    const bucket = byCategory.get(key) ?? { category: name, kind: row.kind, total: 0 };
    bucket.total += minor;
    byCategory.set(key, bucket);
  }

  return {
    count: rows.length,
    currency: rows.find((row) => row.currency)?.currency ?? null,
    totalIncome: fromMinorUnits(income),
    totalExpense: fromMinorUnits(expense),
    net: fromMinorUnits(income - expense),
    byIncomeType: Object.fromEntries(
      Object.entries(byIncomeType).map(([type, minor]) => [type, fromMinorUnits(minor)]),
    ),
    byCategory: [...byCategory.values()]
      .map((bucket) => ({ ...bucket, total: fromMinorUnits(bucket.total) }))
      .sort((a, b) => b.total - a.total),
  };
}

export const FINANCE_CSV_COLUMNS = [
  { header: 'Date', value: (row) => row.occurred_on },
  { header: 'Kind', value: (row) => row.kind },
  { header: 'Income type', value: (row) => row.income_type ?? '' },
  { header: 'Category', value: (row) => row.transaction_categories?.name ?? '' },
  { header: 'Member', value: (row) => row.members?.full_name ?? '' },
  { header: 'Amount', value: (row) => row.amount },
  { header: 'Currency', value: (row) => row.currency ?? '' },
  { header: 'Payment method', value: (row) => row.payment_method ?? '' },
  { header: 'Reference', value: (row) => row.reference ?? '' },
];

/* ---- members ----------------------------------------------------------- */

export function summariseMembers(rows) {
  const byStatus = {};
  const byGender = {};
  let baptised = 0;

  for (const row of rows) {
    const status = row.membership_status ?? 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;

    const gender = row.gender ?? 'unknown';
    byGender[gender] = (byGender[gender] ?? 0) + 1;

    if (row.is_baptized) baptised += 1;
  }

  return { count: rows.length, baptised, byStatus, byGender };
}

export const MEMBERS_CSV_COLUMNS = [
  { header: 'Member no', value: (row) => row.member_no },
  { header: 'Name', value: (row) => row.full_name },
  { header: 'Status', value: (row) => row.membership_status },
  { header: 'Gender', value: (row) => row.gender ?? '' },
  { header: 'Date joined', value: (row) => row.date_joined ?? '' },
  { header: 'Baptised', value: (row) => (row.is_baptized ? 'yes' : 'no') },
  { header: 'Phone', value: (row) => row.phone ?? '' },
  { header: 'Email', value: (row) => row.email ?? '' },
];

/* ---- attendance -------------------------------------------------------- */

export function summariseAttendance(rows) {
  let headcount = 0;
  const byType = {};

  for (const row of rows) {
    const total = Number(row.count_total) || 0;
    headcount += total;

    const type = row.session_type ?? 'other';
    const bucket = byType[type] ?? { sessions: 0, headcount: 0 };
    bucket.sessions += 1;
    bucket.headcount += total;
    byType[type] = bucket;
  }

  return {
    sessions: rows.length,
    totalHeadcount: headcount,
    averageHeadcount: rows.length ? Math.round(headcount / rows.length) : 0,
    byType,
  };
}

export const ATTENDANCE_CSV_COLUMNS = [
  { header: 'Date', value: (row) => row.session_date },
  { header: 'Title', value: (row) => row.title ?? '' },
  { header: 'Type', value: (row) => row.session_type },
  { header: 'Status', value: (row) => row.status },
  { header: 'Headcount', value: (row) => row.count_total ?? 0 },
];

/* ---- ministries -------------------------------------------------------- */

/**
 * Rows are active memberships (`left_on is null`), each embedding its ministry.
 * The report is "who is active in what", so a ministry with no active members
 * simply does not appear — which is the honest answer for this query.
 */
export function summariseMinistries(rows) {
  const perMinistry = new Map();

  for (const row of rows) {
    const name = row.ministries?.name ?? '—';
    const key = row.ministry_id;
    const bucket = perMinistry.get(key) ?? { ministry: name, members: 0 };
    bucket.members += 1;
    perMinistry.set(key, bucket);
  }

  return {
    ministries: perMinistry.size,
    totalMemberships: rows.length,
    perMinistry: [...perMinistry.values()].sort((a, b) => b.members - a.members),
  };
}

export const MINISTRIES_CSV_COLUMNS = [
  { header: 'Ministry', value: (row) => row.ministries?.name ?? '' },
  { header: 'Member', value: (row) => row.members?.full_name ?? '' },
  { header: 'Role', value: (row) => row.role_in_ministry },
  { header: 'Joined', value: (row) => row.joined_on ?? '' },
];

/* ---- events ------------------------------------------------------------ */

export function summariseEvents(rows) {
  const byStatus = {};
  let registrations = 0;

  for (const row of rows) {
    const status = row.status ?? 'draft';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    registrations += Number(row.event_registrations?.[0]?.count ?? 0);
  }

  return { count: rows.length, byStatus, totalRegistrations: registrations };
}

export const EVENTS_CSV_COLUMNS = [
  { header: 'Title', value: (row) => row.title },
  { header: 'Starts', value: (row) => row.starts_at },
  { header: 'Status', value: (row) => row.status },
  { header: 'Capacity', value: (row) => row.capacity ?? '' },
  { header: 'Registrations', value: (row) => row.event_registrations?.[0]?.count ?? 0 },
];
