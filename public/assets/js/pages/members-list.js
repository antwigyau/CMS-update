/**
 * Members list.
 *
 * Search, status filter, sort, and pagination all happen server-side and are
 * reflected in the URL, so a filtered list is a shareable, bookmarkable link and
 * the back button behaves. Nothing is filtered in the browser — §26 of the
 * specification, and the reason the members table has a GIN index.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, stateBlock } from '../core/dom.js';
import { MEMBERSHIP_STATUS_VARIANT, formatDate, humanise } from '../core/format.js';
import { can, requireSession } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';
import { paginationControl } from '../components/pagination.js';

const STATUSES = ['visitor', 'new', 'active', 'inactive', 'transferred', 'deceased'];
const SORTS = [
  { value: 'name', label: 'Surname (A–Z)' },
  { value: '-joined', label: 'Recently joined' },
  { value: 'number', label: 'Member number' },
  { value: 'status', label: 'Status' },
];
const SEARCH_DEBOUNCE_MS = 300;

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/members',
    title: 'Members',
    user: session.user,
    can,
    onSignOut: (await import('../core/session.js')).signOut,
  });

  /** State lives in the URL, so it survives a reload and a shared link. */
  const state = readState();
  const resultsRegion = el('div', { id: 'members-results' });
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

  /* ---- filter bar ------------------------------------------------------- */

  const searchInput = el('input', {
    class: 'form-control',
    id: 'members-search',
    type: 'search',
    value: state.search,
    placeholder: 'Name, member number, phone, email',
    autocomplete: 'off',
  });

  const statusSelect = el('select', { class: 'form-select', id: 'members-status' }, [
    el('option', { value: '', text: 'Any status', selected: state.status === '' }),
    ...STATUSES.map((value) =>
      el('option', { value, text: humanise(value), selected: state.status === value }),
    ),
  ]);

  const sortSelect = el(
    'select',
    { class: 'form-select', id: 'members-sort' },
    SORTS.map((option) =>
      el('option', {
        value: option.value,
        text: option.label,
        selected: state.sort === option.value,
      }),
    ),
  );

  // Debounced so typing a surname is one request, not eight.
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

  const filterBar = el('div', { class: 'filter-bar' }, [
    el('div', { class: 'field filter-bar__search' }, [
      el('label', { class: 'field__label', for: 'members-search', text: 'Search' }),
      searchInput,
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: 'members-status', text: 'Status' }),
      statusSelect,
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: 'members-sort', text: 'Sort by' }),
      sortSelect,
    ]),
  ]);

  /* ---- table ------------------------------------------------------------ */

  function initials(fullName) {
    return (fullName ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('');
  }

  function row(member) {
    return el('tr', {}, [
      el('td', {}, [
        el('div', { class: 'person' }, [
          el('span', {
            class: 'person__avatar',
            'aria-hidden': 'true',
            text: initials(member.fullName),
          }),
          el('div', {}, [
            el('a', {
              class: 'person__name',
              href: `/members/detail?id=${encodeURIComponent(member.id)}`,
              text: member.fullName,
            }),
            el('div', { class: 'person__meta mono', text: member.memberNo }),
          ]),
        ]),
      ]),
      el('td', {}, [
        el('span', {
          class: `pill pill--${MEMBERSHIP_STATUS_VARIANT[member.membershipStatus] ?? 'neutral'}`,
          text: humanise(member.membershipStatus),
        }),
      ]),
      el('td', { class: 'text-sm' }, [
        member.phone ? el('div', { text: member.phone }) : null,
        member.email ? el('div', { class: 'text-muted-token text-xs', text: member.email }) : null,
        !member.phone && !member.email
          ? el('span', { class: 'text-muted-token', text: '—' })
          : null,
      ]),
      el('td', { class: 'text-sm', text: member.city ?? '—' }),
      el('td', { class: 'text-sm', text: formatDate(member.dateJoined) }),
    ]);
  }

  function table(rows) {
    return el('div', { class: 'data-table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: 'Member' }),
            el('th', { scope: 'col', text: 'Status' }),
            el('th', { scope: 'col', text: 'Contact' }),
            el('th', { scope: 'col', text: 'City' }),
            el('th', { scope: 'col', text: 'Joined' }),
          ]),
        ]),
        el('tbody', {}, rows.map(row)),
      ]),
    ]);
  }

  function skeletonTable() {
    return el('div', { class: 'card-surface__body' }, [
      el('div', { class: 'skeleton skeleton--title' }),
      el(
        'div',
        { 'aria-hidden': 'true' },
        Array.from({ length: 6 }, () => el('div', { class: 'skeleton skeleton--text' })),
      ),
    ]);
  }

  /* ---- loading ---------------------------------------------------------- */

  async function load() {
    // Abandon the previous render rather than letting a slow first request
    // overwrite a fast second one.
    const token = {};
    inFlight = token;

    render(resultsRegion, [skeletonTable()]);
    resultsRegion.setAttribute('aria-busy', 'true');

    try {
      const payload = await api.get('/members', {
        query: {
          search: state.search || undefined,
          status: state.status || undefined,
          sort: state.sort,
          page: state.page,
        },
      });

      if (inFlight !== token) return;

      const members = payload.data;
      render(resultsRegion, [
        members.length === 0
          ? stateBlock({
              iconName: state.search || state.status ? 'search' : 'people',
              title:
                state.search || state.status ? 'No members match those filters' : 'No members yet',
              message:
                state.search || state.status
                  ? 'Try a different search term, or clear the filters.'
                  : 'Add the first member to start building the roll.',
              action: can('members.create')
                ? el('a', { class: 'btn btn-primary', href: '/members/new', text: 'Add member' })
                : null,
            })
          : table(members),
        members.length === 0
          ? null
          : paginationControl({
              meta: payload.meta,
              label: 'members',
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
          title: 'Could not load members',
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

  // The back button should restore the list the URL describes.
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
        el('h1', { class: 'page-header__title', text: 'Members' }),
        el('p', { class: 'page-header__subtitle', text: 'The membership roll for your branch.' }),
      ]),
      can('members.create')
        ? el('div', { class: 'page-header__actions' }, [
            el('a', { class: 'btn btn-primary', href: '/members/new' }, [
              icon('person-plus'),
              ' Add member',
            ]),
          ])
        : null,
    ]),
    el('section', { class: 'card-surface' }, [filterBar, resultsRegion]),
  ]);

  writeState({ replace: true });
  await load();

  if (new URLSearchParams(location.search).get('created') === '1') {
    notify.success('Member added.');
  }
}
