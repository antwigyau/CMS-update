/**
 * A recording stand-in for the Supabase query builder, shared by the feature
 * module tests.
 *
 * What this proves: that a service builds the query it should — the filters, the
 * embedded selects, the sort, the range. Those are the parts where a mistake is
 * silent: a forgotten filter returns MORE rows, not an error, and only RLS would
 * contain the damage.
 *
 * What it does NOT prove: that PostgREST accepts the query. The method names and
 * argument shapes follow supabase-js, but only a real Supabase project can confirm
 * the wire format. That gap is recorded in README.md and docs/SECURITY.md.
 */

/**
 * @param {object} [options]
 * @param {object[]} [options.rows]   Rows the query resolves with.
 * @param {number|null} [options.count]
 * @param {object} [options.error]    A PostgREST-shaped error to resolve with.
 * @param {Record<string, object>} [options.perTable]
 *   Per-table overrides of `{ rows, count, error }`, for handlers that query more
 *   than one table in a single request.
 */
export function createQueryRecorder({ rows = [], count = null, error = null, perTable = {} } = {}) {
  /** Every chained call, in order: [method, ...arguments]. */
  const calls = [];
  /** rpc() invocations, kept separately since they bypass the builder. */
  const rpcCalls = [];

  /** The table of the most recent from(), so perTable can select a result. */
  let currentTable = null;

  function resultFor() {
    const override = perTable[currentTable];
    return {
      rows: override?.rows ?? rows,
      count: override?.count ?? count,
      error: override?.error ?? error,
    };
  }

  function record(method, ...args) {
    calls.push([method, ...args]);
    return builder;
  }

  const builder = {
    select: (...args) => record('select', ...args),
    insert: (...args) => record('insert', ...args),
    update: (...args) => record('update', ...args),
    delete: (...args) => record('delete', ...args),
    eq: (...args) => record('eq', ...args),
    is: (...args) => record('is', ...args),
    not: (...args) => record('not', ...args),
    or: (...args) => record('or', ...args),
    in: (...args) => record('in', ...args),
    gte: (...args) => record('gte', ...args),
    lte: (...args) => record('lte', ...args),
    ilike: (...args) => record('ilike', ...args),
    textSearch: (...args) => record('textSearch', ...args),
    order: (...args) => record('order', ...args),
    range: (...args) => record('range', ...args),

    // The terminal calls. supabase-js builders are thenable, so awaiting the chain
    // is what issues the request; single/maybeSingle narrow the shape.
    single() {
      calls.push(['single']);
      const { rows: r, error: e, count: c } = resultFor();
      return Promise.resolve({ data: r[0] ?? null, error: e, count: c });
    },
    maybeSingle() {
      calls.push(['maybeSingle']);
      const { rows: r, error: e, count: c } = resultFor();
      return Promise.resolve({ data: r[0] ?? null, error: e, count: c });
    },
    then(resolve, reject) {
      const { rows: r, error: e, count: c } = resultFor();
      return Promise.resolve({ data: r, error: e, count: c }).then(resolve, reject);
    },
  };

  const client = {
    from(table) {
      currentTable = table;
      calls.push(['from', table]);
      return builder;
    },
    rpc(name, params) {
      rpcCalls.push({ name, params });
      const { rows: r, error: e, count: c } = resultFor();
      return Promise.resolve({ data: r, error: e, count: c });
    },
  };

  return {
    client,
    getClient: () => client,
    calls,
    rpcCalls,

    /** Arguments of the first call to `method`, or null. */
    argsFor(method) {
      const found = calls.find(([name]) => name === method);
      return found ? found.slice(1) : null;
    },

    /** Every call to `method`, as argument arrays. */
    allArgsFor(method) {
      return calls.filter(([name]) => name === method).map((call) => call.slice(1));
    },

    called(method) {
      return calls.some(([name]) => name === method);
    },

    /** Tables touched, in order. Useful for "did it read the household first?". */
    tables() {
      return calls.filter(([name]) => name === 'from').map(([, table]) => table);
    },
  };
}
