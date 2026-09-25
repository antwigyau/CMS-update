/**
 * Households list.
 *
 * Same shape as the members list: search and paging are server-side and live in
 * the URL, so a filtered view is a shareable link and the back button works.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, stateBlock } from '../core/dom.js';
import { formatCount } from '../core/format.js';
import { can, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { paginationControl } from '../components/pagination.js';

const SORTS = [
  { value: 'name', label: 'Household name (A–Z)' },
  { value: 'city', label: 'City' },
  { value: '-created', label: 'Recently added' },
];
const SEARCH_DEBOUNCE_MS = 300;

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/families',
    title: 'Families',
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
      sort: params.get('sort') ?? 'name',
      page: Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1),
    };
  }

  function writeState({ replace = false } = {}) {
    const params = new URLSearchParams();
    if (state.search) params.set('search', state.search);
    if (state.sort !== 'name') params.set('sort', state.sort);
    if (state.page > 1) params.set('page', String(state.page));

    const url = `${location.pathname}${params.toString() ? `?${params}` : ''}`;
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }

  const searchInput = el('input', {
    class: 'form-control',
    id: 'families-search',
    type: 'search',
    value: state.search,
    placeholder: 'Household name',
    autocomplete: 'off',
  });

  const sortSelect = el(
    'select',
    { class: 'form-select', id: 'families-sort' },
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

  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value;
    state.page = 1;
    writeState();
    load();
  });

  function row(family) {
    return el('tr', {}, [
      el('td', {}, [
        el('a', {
          class: 'person__name',
          href: `/families/detail?id=${encodeURIComponent(family.id)}`,
          text: family.familyName,
        }),
      ]),
      el('td', { class: 'text-sm' }, [
        family.memberCount === null
          ? el('span', { class: 'text-muted-token', text: '—' })
          : el('span', {
              class: 'pill pill--neutral',
              text: formatCount(family.memberCount, 'member'),
            }),
      ]),
      el('td', { class: 'text-sm', text: family.householdPhone ?? '—' }),
      el('td', { class: 'text-sm', text: family.city ?? '—' }),
    ]);
  }

  function table(rows) {
    return el('div', { class: 'data-table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: 'Household' }),
            el('th', { scope: 'col', text: 'Members' }),
            el('th', { scope: 'col', text: 'Phone' }),
            el('th', { scope: 'col', text: 'City' }),
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
      const payload = await api.get('/families', {
        query: { search: state.search || undefined, sort: state.sort, page: state.page },
      });
      if (inFlight !== token) return;

      const families = payload.data;
      render(resultsRegion, [
        families.length === 0
          ? stateBlock({
              iconName: state.search ? 'search' : 'house-heart',
              title: state.search ? 'No households match that search' : 'No households yet',
              message: state.search
                ? 'Try a different name, or clear the search.'
                : 'Group members into households to keep addresses and contact details together.',
              action: can('families.create')
                ? el('a', {
                    class: 'btn btn-primary',
                    href: '/families/new',
                    text: 'Add household',
                  })
                : null,
            })
          : table(families),
        families.length === 0
          ? null
          : paginationControl({
              meta: payload.meta,
              label: 'households',
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
          title: 'Could not load households',
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
    sortSelect.value = state.sort;
    load();
  });

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'Families' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'Households, so addresses and contact details live in one place.',
        }),
      ]),
      can('families.create')
        ? el('div', { class: 'page-header__actions' }, [
            el('a', { class: 'btn btn-primary', href: '/families/new' }, [
              icon('house-add'),
              ' Add household',
            ]),
          ])
        : null,
    ]),
    el('section', { class: 'card-surface' }, [
      el('div', { class: 'filter-bar' }, [
        el('div', { class: 'field filter-bar__search' }, [
          el('label', { class: 'field__label', for: 'families-search', text: 'Search' }),
          searchInput,
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'field__label', for: 'families-sort', text: 'Sort by' }),
          sortSelect,
        ]),
      ]),
      resultsRegion,
    ]),
  ]);

  writeState({ replace: true });
  await load();
}
