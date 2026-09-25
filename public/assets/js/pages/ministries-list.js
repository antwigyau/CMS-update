/**
 * Ministries list.
 *
 * `youLead` comes from the API, which computes it from the caller's leadership —
 * so a leader sees a marker on their own ministry without holding any branch-wide
 * permission. It decides what to render; every endpoint checks again.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, stateBlock } from '../core/dom.js';
import { formatCount, formatMeetingSchedule, humanise } from '../core/format.js';
import { can, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { paginationControl } from '../components/pagination.js';

const SORTS = [
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'status', label: 'Status' },
  { value: '-created', label: 'Recently added' },
];
const SEARCH_DEBOUNCE_MS = 300;

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/ministries',
    title: 'Ministries',
    user: session.user,
    can,
    onSignOut: signOut,
  });

  const state = readState();
  const resultsRegion = el('div');
  let inFlight = null;

  function readState() {
    const params = new URLSearchParams(location.search);
    return {
      search: params.get('search') ?? '',
      status: params.get('status') ?? '',
      sort: params.get('sort') ?? 'name',
      page: Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1),
    };
  }

  function writeState({ replace = false } = {}) {
    const params = new URLSearchParams();
    if (state.search) params.set('search', state.search);
    if (state.status) params.set('status', state.status);
    if (state.sort !== 'name') params.set('sort', state.sort);
    if (state.page > 1) params.set('page', String(state.page));

    const url = `${location.pathname}${params.toString() ? `?${params}` : ''}`;
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }

  const searchInput = el('input', {
    class: 'form-control',
    id: 'ministries-search',
    type: 'search',
    value: state.search,
    placeholder: 'Ministry name',
    autocomplete: 'off',
  });

  const statusSelect = el('select', { class: 'form-select', id: 'ministries-status' }, [
    el('option', { value: '', text: 'Any status', selected: state.status === '' }),
    el('option', { value: 'active', text: 'Active', selected: state.status === 'active' }),
    el('option', { value: 'inactive', text: 'Inactive', selected: state.status === 'inactive' }),
  ]);

  const sortSelect = el(
    'select',
    { class: 'form-select', id: 'ministries-sort' },
    SORTS.map((option) =>
      el('option', {
        value: option.value,
        text: option.label,
        selected: state.sort === option.value,
      }),
    ),
  );

  let debounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.search = searchInput.value.trim();
      state.page = 1;
      writeState();
      load();
    }, SEARCH_DEBOUNCE_MS);
  });

  for (const [control, key] of [
    [statusSelect, 'status'],
    [sortSelect, 'sort'],
  ]) {
    control.addEventListener('change', () => {
      state[key] = control.value;
      state.page = 1;
      writeState();
      load();
    });
  }

  function row(ministry) {
    return el('tr', {}, [
      el('td', {}, [
        el('div', {}, [
          el('a', {
            class: 'person__name',
            href: `/ministries/detail?id=${encodeURIComponent(ministry.id)}`,
            text: ministry.name,
          }),
          ministry.code ? el('div', { class: 'person__meta mono', text: ministry.code }) : null,
        ]),
      ]),
      el('td', {}, [
        el('span', {
          class: `pill pill--${ministry.status === 'active' ? 'success' : 'neutral'}`,
          text: humanise(ministry.status),
        }),
      ]),
      el('td', { class: 'text-sm' }, [
        ministry.memberCount === null
          ? el('span', { class: 'text-muted-token', text: '—' })
          : el('span', { text: formatCount(ministry.memberCount, 'member') }),
      ]),
      el('td', {
        class: 'text-sm',
        text: formatMeetingSchedule(ministry.meetingDay, ministry.meetingTime),
      }),
      el('td', {}, [
        ministry.youLead
          ? el('span', { class: 'pill pill--brand' }, [icon('star-fill'), ' You lead this'])
          : el('span', { class: 'text-muted-token', text: '—' }),
      ]),
    ]);
  }

  function table(rows) {
    return el('div', { class: 'data-table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: 'Ministry' }),
            el('th', { scope: 'col', text: 'Status' }),
            el('th', { scope: 'col', text: 'Members' }),
            el('th', { scope: 'col', text: 'Meets' }),
            el('th', { scope: 'col' }, [el('span', { class: 'sr-only', text: 'Your role' })]),
          ]),
        ]),
        el('tbody', {}, rows.map(row)),
      ]),
    ]);
  }

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
      const payload = await api.get('/ministries', {
        query: {
          search: state.search || undefined,
          status: state.status || undefined,
          sort: state.sort,
          page: state.page,
        },
      });
      if (inFlight !== token) return;

      const ministries = payload.data;
      render(resultsRegion, [
        ministries.length === 0
          ? stateBlock({
              iconName: state.search || state.status ? 'search' : 'diagram-3',
              title:
                state.search || state.status
                  ? 'No ministries match those filters'
                  : 'No ministries yet',
              message:
                state.search || state.status
                  ? 'Try a different name, or clear the filters.'
                  : 'Create a ministry to group the people who serve in it.',
              action: can('ministries.create')
                ? el('a', {
                    class: 'btn btn-primary',
                    href: '/ministries/new',
                    text: 'Add ministry',
                  })
                : null,
            })
          : table(ministries),
        ministries.length === 0
          ? null
          : paginationControl({
              meta: payload.meta,
              label: 'ministries',
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
          title: 'Could not load ministries',
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
    searchInput.value = state.search;
    statusSelect.value = state.status;
    sortSelect.value = state.sort;
    load();
  });

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'Ministries' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'The groups people serve in, and who leads each one.',
        }),
      ]),
      can('ministries.create')
        ? el('div', { class: 'page-header__actions' }, [
            el('a', { class: 'btn btn-primary', href: '/ministries/new' }, [
              icon('plus-lg'),
              ' Add ministry',
            ]),
          ])
        : null,
    ]),
    el('section', { class: 'card-surface' }, [
      el('div', { class: 'filter-bar' }, [
        el('div', { class: 'field filter-bar__search' }, [
          el('label', { class: 'field__label', for: 'ministries-search', text: 'Search' }),
          searchInput,
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field__label', for: 'ministries-status', text: 'Status' }),
          statusSelect,
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field__label', for: 'ministries-sort', text: 'Sort by' }),
          sortSelect,
        ]),
      ]),
      resultsRegion,
    ]),
  ]);

  writeState({ replace: true });
  await load();
}
