/**
 * The transaction ledger.
 *
 * Every row shows its status, because a transaction only counts once approved and
 * the list is where a treasurer sees what is still a draft, waiting, or was sent
 * back. Amounts are formatted in each row's own currency — historically a ledger is
 * single-currency, but the row carries its currency so a future change does not
 * silently reinterpret old figures.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, stateBlock } from '../core/dom.js';
import { TRANSACTION_STATUS_VARIANT, formatDate, formatMoney, humanise } from '../core/format.js';
import { can, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { paginationControl } from '../components/pagination.js';

const KINDS = ['income', 'expense'];
const STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'void'];

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/finance',
    title: 'Finance',
    user: session.user,
    can,
    onSignOut: signOut,
  });

  const state = readState();
  const resultsRegion = el('div');
  const headerRegion = el('div', { class: 'filter-bar' });
  let categories = [];
  let inFlight = null;

  function readState() {
    const params = new URLSearchParams(location.search);
    return {
      kind: params.get('kind') ?? '',
      status: params.get('status') ?? '',
      categoryId: params.get('categoryId') ?? '',
      from: params.get('from') ?? '',
      to: params.get('to') ?? '',
      search: params.get('search') ?? '',
      page: Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1),
    };
  }

  function writeState({ replace = false } = {}) {
    const params = new URLSearchParams();
    for (const key of ['kind', 'status', 'categoryId', 'from', 'to', 'search']) {
      if (state[key]) params.set(key, state[key]);
    }
    if (state.page > 1) params.set('page', String(state.page));

    const url = `${location.pathname}${params.toString() ? `?${params}` : ''}`;
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }

  /* ---- header ----------------------------------------------------------- */

  function selectField(id, label, value, options, onchange) {
    const select = el('select', { class: 'form-select', id, 'aria-label': label }, options);
    select.value = value;
    select.addEventListener('change', () => {
      onchange(select.value);
      state.page = 1;
      writeState();
      load();
    });
    return el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: id, text: label }),
      select,
    ]);
  }

  function dateField(id, label, value, onchange) {
    const input = el('input', { class: 'form-control', id, type: 'date', value });
    input.addEventListener('change', () => {
      onchange(input.value);
      state.page = 1;
      writeState();
      load();
    });
    return el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: id, text: label }),
      input,
    ]);
  }

  function renderHeader() {
    const searchInput = el('input', {
      class: 'form-control',
      id: 'finance-search',
      type: 'search',
      placeholder: 'Reference or note',
      value: state.search,
    });
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = searchInput.value.trim();
        state.page = 1;
        writeState();
        load();
      }, 250);
    });

    render(headerRegion, [
      selectField(
        'finance-kind',
        'Type',
        state.kind,
        [
          el('option', { value: '', text: 'Income and expense' }),
          ...KINDS.map((value) => el('option', { value, text: humanise(value) })),
        ],
        (value) => {
          state.kind = value;
        },
      ),
      selectField(
        'finance-status',
        'Status',
        state.status,
        [
          el('option', { value: '', text: 'Any status' }),
          ...STATUSES.map((value) => el('option', { value, text: humanise(value) })),
        ],
        (value) => {
          state.status = value;
        },
      ),
      selectField(
        'finance-category',
        'Category',
        state.categoryId,
        [
          el('option', { value: '', text: 'Any category' }),
          ...categories.map((category) =>
            el('option', {
              value: category.id,
              text: `${humanise(category.kind)}: ${category.name}`,
            }),
          ),
        ],
        (value) => {
          state.categoryId = value;
        },
      ),
      dateField('finance-from', 'From', state.from, (value) => {
        state.from = value;
      }),
      dateField('finance-to', 'To', state.to, (value) => {
        state.to = value;
      }),
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', for: 'finance-search', text: 'Search' }),
        searchInput,
      ]),
    ]);
  }

  /* ---- view ------------------------------------------------------------- */

  const detailHref = (txn) => `/finance/detail?id=${encodeURIComponent(txn.id)}`;

  function amountCell(txn) {
    const signed = txn.kind === 'expense';
    return el('td', { class: 'data-table__numeric' }, [
      el('span', {
        class: signed ? 'text-danger-token' : '',
        text: `${signed ? '−' : ''}${formatMoney(txn.amount, txn.currency)}`,
      }),
    ]);
  }

  function listRow(txn) {
    const who =
      txn.kind === 'income' ? (txn.isAnonymous ? 'Anonymous' : (txn.memberName ?? '—')) : '—';
    return el('tr', {}, [
      el('td', { class: 'text-sm', text: formatDate(txn.occurredOn) }),
      el('td', {}, [
        el('div', {}, [
          el('a', { class: 'person__name', href: detailHref(txn), text: txn.categoryName ?? '—' }),
          el('div', { class: 'person__meta' }, [
            humanise(txn.kind),
            txn.incomeType ? ` · ${humanise(txn.incomeType)}` : '',
            txn.reference ? ` · ${txn.reference}` : '',
          ]),
        ]),
      ]),
      el('td', { class: 'text-sm', text: who }),
      amountCell(txn),
      el('td', {}, [
        el('span', {
          class: `pill pill--${TRANSACTION_STATUS_VARIANT[txn.status] ?? 'neutral'}`,
          text: humanise(txn.status),
        }),
      ]),
    ]);
  }

  function listView(transactions) {
    return el('div', { class: 'data-table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: 'Date' }),
            el('th', { scope: 'col', text: 'Category' }),
            el('th', { scope: 'col', text: 'Member' }),
            el('th', { scope: 'col', class: 'data-table__numeric', text: 'Amount' }),
            el('th', { scope: 'col', text: 'Status' }),
          ]),
        ]),
        el('tbody', {}, transactions.map(listRow)),
      ]),
    ]);
  }

  /* ---- loading ---------------------------------------------------------- */

  async function load() {
    const token = {};
    inFlight = token;

    render(resultsRegion, [
      el('div', { class: 'card-surface__body' }, [
        el('div', { class: 'skeleton skeleton--title' }),
        el(
          'div',
          { 'aria-hidden': 'true' },
          Array.from({ length: 5 }, () => el('div', { class: 'skeleton skeleton--text' })),
        ),
      ]),
    ]);
    resultsRegion.setAttribute('aria-busy', 'true');

    try {
      const payload = await api.get('/transactions', {
        query: {
          kind: state.kind || undefined,
          status: state.status || undefined,
          categoryId: state.categoryId || undefined,
          from: state.from || undefined,
          to: state.to || undefined,
          search: state.search || undefined,
          page: state.page,
        },
      });
      if (inFlight !== token) return;

      const transactions = payload.data;

      if (transactions.length === 0) {
        render(resultsRegion, [
          stateBlock({
            iconName: 'cash-stack',
            title: 'No transactions match those filters',
            message: can('finance.create')
              ? 'Record a transaction to start the ledger.'
              : 'Nothing to show here yet.',
            action: can('finance.create')
              ? el('a', {
                  class: 'btn btn-primary',
                  href: '/finance/new',
                  text: 'Record a transaction',
                })
              : null,
          }),
        ]);
        return;
      }

      render(resultsRegion, [
        listView(transactions),
        paginationControl({
          meta: payload.meta,
          label: 'transactions',
          onChange: (page) => {
            state.page = page;
            writeState();
            load();
            document.getElementById('main-content')?.focus();
          },
        }),
      ]);
    } catch (error) {
      if (inFlight !== token) return;
      render(resultsRegion, [
        stateBlock({
          variant: 'error',
          title: 'Could not load transactions',
          message:
            error instanceof ApiError
              ? `${error.message}${error.requestId ? ` (reference ${error.requestId})` : ''}`
              : 'Something went wrong.',
          action: el('button', {
            class: 'btn btn-outline-secondary',
            type: 'button',
            text: 'Try again',
            onclick: load,
          }),
        }),
      ]);
    } finally {
      if (inFlight === token) resultsRegion.removeAttribute('aria-busy');
    }
  }

  window.addEventListener('popstate', () => {
    Object.assign(state, readState());
    renderHeader();
    load();
  });

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'Finance' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'Tithes, offerings, donations, and expenses — every one approved before it counts.',
        }),
      ]),
      el('div', { class: 'page-header__actions' }, [
        can('finance.approve')
          ? el('a', { class: 'btn btn-outline-secondary', href: '/finance/approvals' }, [
              icon('inbox'),
              ' Approvals',
            ])
          : null,
        can('finance.categories.manage')
          ? el('a', { class: 'btn btn-outline-secondary', href: '/finance/categories' }, [
              icon('tags'),
              ' Categories',
            ])
          : null,
        can('finance.create')
          ? el('a', { class: 'btn btn-primary', href: '/finance/new' }, [
              icon('plus-lg'),
              ' Record a transaction',
            ])
          : null,
      ]),
    ]),
    el('section', { class: 'card-surface' }, [headerRegion, resultsRegion]),
  ]);

  renderHeader();
  writeState({ replace: true });

  api
    .get('/transaction-categories')
    .then((payload) => {
      categories = payload.data;
      renderHeader();
    })
    .catch(() => {});

  await load();
}
