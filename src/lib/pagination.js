/**
 * Pagination.
 *
 * Offset-based, deliberately. Keyset pagination is faster on deep pages, but the
 * member list needs "page 7 of 24" and a jump-to-page control, which keyset
 * cannot give. At congregation scale — thousands of rows, not millions — the
 * offset cost is irrelevant, and the indexes in Phase 2 cover the sort orders the
 * UI offers.
 *
 * Two properties matter more than the algorithm:
 *
 *   * the page size is capped SERVER-side, so `?pageSize=100000` cannot be used to
 *     pull the whole roll in one request (§19 and §27 of the specification)
 *   * the total count comes from the same filtered query, so "24 pages" is true
 *     rather than an estimate over the unfiltered table
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Read pagination from a query string, ignoring nonsense rather than failing.
 *
 * A bad `page` is a link someone edited or a stale bookmark, not an attack. Page
 * 1 is a more useful answer than a 422, and the cap is what actually protects the
 * database.
 */
export function readPagination(query, { defaultPageSize = DEFAULT_PAGE_SIZE } = {}) {
  const rawPage = Number.parseInt(query.get('page') ?? '', 10);
  const rawSize = Number.parseInt(query.get('pageSize') ?? '', 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize =
    Number.isFinite(rawSize) && rawSize > 0 ? Math.min(rawSize, MAX_PAGE_SIZE) : defaultPageSize;

  return {
    page,
    pageSize,
    // Inclusive bounds, which is what PostgREST's .range() expects.
    from: (page - 1) * pageSize,
    to: page * pageSize - 1,
  };
}

/**
 * Build the `meta` block that accompanies a paginated response.
 *
 * `total` may be null: PostgREST returns no count unless asked, and some queries
 * deliberately skip it. The shape stays the same either way so the frontend has
 * one code path.
 */
export function buildPageMeta({ page, pageSize, total }) {
  const knownTotal = typeof total === 'number' && Number.isFinite(total) ? total : null;
  const pageCount = knownTotal === null ? null : Math.max(1, Math.ceil(knownTotal / pageSize));

  return {
    page,
    pageSize,
    total: knownTotal,
    pageCount,
    hasPrevious: page > 1,
    // Without a total, "is there a next page" is unknowable here; the caller
    // fills it in from whether a full page came back.
    hasNext: pageCount === null ? null : page < pageCount,
  };
}

/**
 * A whitelist-based sort parser.
 *
 * The column name reaches a query builder, so it must never come from user input
 * unchecked — even through PostgREST, an arbitrary column name leaks the shape of
 * the table through its error messages. Anything unrecognised falls back to the
 * default rather than erroring, for the same reason as `readPagination`.
 *
 * @param {string|null} value      e.g. "name" or "-joined"
 * @param {Record<string, string>} allowed  sort key -> column name
 * @param {string} defaultKey
 */
export function readSort(value, allowed, defaultKey) {
  const raw = (value ?? '').trim();
  const descending = raw.startsWith('-');
  const key = descending ? raw.slice(1) : raw;

  const column = allowed[key];
  if (!column) {
    return { key: defaultKey, column: allowed[defaultKey], ascending: true };
  }
  return { key, column, ascending: !descending };
}
