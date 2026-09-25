/**
 * Users admin — the account roster.
 *
 * Search, status, sort, and pagination all happen server-side and live in the
 * URL, so a filtered roster is a shareable link and the back button behaves —
 * the same shape as the members list. Every control here is a convenience; the
 * API and RLS refuse a request regardless of what this page renders.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, stateBlock } from '../core/dom.js';
import { formatDateTime } from '../core/format.js';
import { can, churchName, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { paginationControl } from '../components/pagination.js';

const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Deactivated' },
];
const SORTS = [
  { value: 'name', label: 'Name (A–Z)' },
  { value: '-name', label: 'Name (Z–A)' },
  { value: '-created', label: 'Recently added' },
  { value: '-lastLogin', label: 'Recent sign-in' },
];
const SEARCH_DEBOUNCE_MS = 300;

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/admin/users',
    title: 'Users',
    user: session.user,
    can,
    onSignOut: signOut,
    churchName: churchName(),
  });

  /** State lives in the URL, so it survives a reload and a shared link. */
  const state = readState();
  const resultsRegion = el('div', { id: 'users-results' });
  let inFlight = null;

  function readState() {
    const params = new URLSearchParams(location.search);
    return {
      search: params.get('search') ?? '',
      active: params.get('active') ?? '',
      sort: params.get('sort') ?? 'name',
      page: Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1),
    };
  }

  function writeState({ replace = false } = {}) {
    const params = new URLSearchParams();
    if (state.search) params.set('search', state.search);
    if (state.active) params.set('active', state.active);
    if (state.sort !== 'name') params.set('sort', state.sort);
    if (state.page > 1) params.set('page', String(state.page));

    const url = `${location.pathname}${params.toString() ? `?${params}` : ''}`;
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }

  /* ---- filter bar ------------------------------------------------------- */

  const searchInput = el('input', {
    class: 'form-control',
    id: 'users-search',
    type: 'search',
    value: state.search,
    placeholder: 'Name',
    autocomplete: 'off',
  });

  const statusSelect = el(
    'select',
    { class: 'form-select', id: 'users-status' },
    STATUS_OPTIONS.map((option) =>
      el('option', {
        value: option.value,
        text: option.label,
        selected: state.active === option.value,
      }),
    ),
  );

  const sortSelect = el(
    'select',
    { class: 'form-select', id: 'users-sort' },
    SORTS.map((option) =>
      el('option', {
        value: option.value,
        text: option.label,
        selected: state.sort === option.value,
      }),
    ),
  );

  // Debounced so typing a name is one request, not eight.
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
    [statusSelect, 'active'],
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
      el('label', { class: 'field__label', for: 'users-search', text: 'Search' }),
      searchInput,
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: 'users-status', text: 'Status' }),
      statusSelect,
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: 'users-sort', text: 'Sort by' }),
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

  /** Role names for the row, or an em dash when none are granted yet. */
  function roleNames(user) {
    const names = (user.roles ?? []).map((grant) => grant.roleName).filter(Boolean);
    return names.length ? names.join(', ') : '—';
  }

  function row(user) {
    return el('tr', {}, [
      el('td', {}, [
        el('div', { class: 'person' }, [
          el('span', {
            class: 'person__avatar',
            'aria-hidden': 'true',
            text: initials(user.fullName),
          }),
          el('div', {}, [
            el('a', {
              class: 'person__name',
              href: `/admin/users/detail?id=${encodeURIComponent(user.id)}`,
              text: user.fullName,
            }),
          ]),
        ]),
      ]),
      el('td', {}, [
        el('span', {
          class: `pill pill--${user.isActive ? 'success' : 'neutral'}`,
          text: user.isActive ? 'Active' : 'Deactivated',
        }),
      ]),
      el('td', { class: 'text-sm', text: roleNames(user) }),
      el('td', { class: 'text-sm', text: formatDateTime(user.lastLoginAt) }),
    ]);
  }

  function table(rows) {
    return el('div', { class: 'data-table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: 'Name' }),
            el('th', { scope: 'col', text: 'Status' }),
            el('th', { scope: 'col', text: 'Roles' }),
            el('th', { scope: 'col', text: 'Last sign-in' }),
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
      const payload = await api.get('/admin/users', {
        query: {
          search: state.search || undefined,
          active: state.active || undefined,
          sort: state.sort,
          page: state.page,
        },
      });

      if (inFlight !== token) return;

      const users = payload.data;
      const filtered = Boolean(state.search || state.active);
      render(resultsRegion, [
        users.length === 0
          ? stateBlock({
              iconName: filtered ? 'search' : 'people',
              title: filtered ? 'No users match those filters' : 'No users yet',
              message: filtered
                ? 'Try a different search term, or clear the filters.'
                : 'Invite someone to give them access.',
              action: can('users.invite')
                ? el('a', {
                    class: 'btn btn-primary',
                    href: '/admin/users/new',
                    text: 'Invite user',
                  })
                : null,
            })
          : table(users),
        users.length === 0
          ? null
          : paginationControl({
              meta: payload.meta,
              label: 'users',
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
          title: 'Could not load users',
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

  // The back button should restore the roster the URL describes.
  window.addEventListener('popstate', () => {
    Object.assign(state, readState());
    searchInput.value = state.search;
    statusSelect.value = state.active;
    sortSelect.value = state.sort;
    load();
  });

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'Users' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'The people who can sign in to manage this church.',
        }),
      ]),
      can('users.invite')
        ? el('div', { class: 'page-header__actions' }, [
            el('a', { class: 'btn btn-primary', href: '/admin/users/new' }, [
              icon('person-plus'),
              ' Invite user',
            ]),
          ])
        : null,
    ]),
    el('section', { class: 'card-surface' }, [filterBar, resultsRegion]),
  ]);

  writeState({ replace: true });
  await load();
}
