/**
 * Pagination and sort parsing.
 *
 * These are small pure functions, but they carry two security-relevant
 * responsibilities: the page-size cap that stops a caller pulling the whole roll
 * in one request (§19, §27), and the sort allow-list that keeps a user-supplied
 * column name out of the query builder.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildPageMeta,
  readPagination,
  readSort,
} from '../../src/lib/pagination.js';

const query = (search) => new URLSearchParams(search);

describe('readPagination', () => {
  it('defaults to the first page at the documented size', () => {
    assert.deepEqual(readPagination(query('')), {
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      from: 0,
      to: DEFAULT_PAGE_SIZE - 1,
    });
  });

  it('computes an inclusive range, as PostgREST expects', () => {
    const { from, to } = readPagination(query('page=3&pageSize=10'));
    assert.equal(from, 20);
    assert.equal(to, 29);
  });

  it('caps the page size, whatever is asked for', () => {
    assert.equal(readPagination(query('pageSize=100000')).pageSize, MAX_PAGE_SIZE);
    assert.equal(readPagination(query(`pageSize=${MAX_PAGE_SIZE + 1}`)).pageSize, MAX_PAGE_SIZE);
  });

  it('treats nonsense as page 1, rather than erroring on a stale bookmark', () => {
    for (const search of ['page=0', 'page=-1', 'page=abc', 'page=1.5e9999', 'page=']) {
      assert.equal(readPagination(query(search)).page, 1, search);
    }
  });

  it('treats a nonsense page size as the default', () => {
    for (const search of ['pageSize=0', 'pageSize=-10', 'pageSize=abc']) {
      assert.equal(readPagination(query(search)).pageSize, DEFAULT_PAGE_SIZE, search);
    }
  });

  it('accepts a caller-supplied default, for endpoints with a different natural size', () => {
    assert.equal(readPagination(query(''), { defaultPageSize: 20 }).pageSize, 20);
  });
});

describe('buildPageMeta', () => {
  it('describes a middle page', () => {
    assert.deepEqual(buildPageMeta({ page: 2, pageSize: 10, total: 57 }), {
      page: 2,
      pageSize: 10,
      total: 57,
      pageCount: 6,
      hasPrevious: true,
      hasNext: true,
    });
  });

  it('describes the only page', () => {
    const meta = buildPageMeta({ page: 1, pageSize: 25, total: 3 });
    assert.equal(meta.pageCount, 1);
    assert.equal(meta.hasPrevious, false);
    assert.equal(meta.hasNext, false);
  });

  it('reports one page when there are no rows at all, so a pager still renders', () => {
    assert.equal(buildPageMeta({ page: 1, pageSize: 25, total: 0 }).pageCount, 1);
  });

  it('leaves the count unknown rather than guessing when none was fetched', () => {
    const meta = buildPageMeta({ page: 1, pageSize: 25, total: null });
    assert.equal(meta.total, null);
    assert.equal(meta.pageCount, null);
    assert.equal(meta.hasNext, null, 'null means unknown, which is not the same as false');
    assert.equal(meta.hasPrevious, false, 'but this one is knowable');
  });
});

describe('readSort', () => {
  const allowed = { name: 'last_name', joined: 'date_joined' };

  it('resolves an allowed key to its column, ascending by default', () => {
    assert.deepEqual(readSort('joined', allowed, 'name'), {
      key: 'joined',
      column: 'date_joined',
      ascending: true,
    });
  });

  it('reads a leading minus as descending', () => {
    assert.deepEqual(readSort('-joined', allowed, 'name'), {
      key: 'joined',
      column: 'date_joined',
      ascending: false,
    });
  });

  it('falls back to the default for anything not on the allow-list', () => {
    for (const value of ['notes', 'members.notes', 'id; drop table members', '', null, undefined]) {
      const sort = readSort(value, allowed, 'name');
      assert.equal(sort.column, 'last_name', String(value));
    }
  });

  it('never returns a column that is not one of the allowed values', () => {
    const columns = new Set(Object.values(allowed));
    for (const value of ['x', '-x', 'password', '-notes']) {
      assert.ok(columns.has(readSort(value, allowed, 'name').column));
    }
  });
});
