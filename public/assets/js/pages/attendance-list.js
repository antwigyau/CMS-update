/**
 * Attendance sessions list.
 *
 * Newest first, because the register someone wants is almost always the most
 * recent one. Both counts are shown side by side — "212 counted, 148 identified" —
 * which is decision D5 made visible rather than hidden behind one number.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, stateBlock } from '../core/dom.js';
import { formatDate, humanise } from '../core/format.js';
import { can, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { paginationControl } from '../components/pagination.js';

const TYPES = ['service', 'ministry', 'event'];

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/attendance',
    title: 'Attendance',
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
      sessionType: params.get('sessionType') ?? '',
      status: params.get('status') ?? '',
      from: params.get('from') ?? '',
      to: params.get('to') ?? '',
      page: Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1),
    };
  }

  function writeState({ replace = false } = {}) {
    const params = new URLSearchParams();
    for (const key of ['sessionType', 'status', 'from', 'to']) {
      if (state[key]) params.set(key, state[key]);
    }
    if (state.page > 1) params.set('page', String(state.page));

    const url = `${location.pathname}${params.toString() ? `?${params}` : ''}`;
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }

  function filterControl({ id, label, type = 'select', options = [], blank }) {
    const control =
      type === 'date'
        ? el('input', { class: 'form-control', id, type: 'date', value: state[id] })
        : el('select', { class: 'form-select', id }, [
            el('option', { value: '', text: blank, selected: state[id] === '' }),
            ...options.map((value) =>
              el('option', { value, text: humanise(value), selected: state[id] === value }),
            ),
          ]);

    control.addEventListener('change', () => {
      state[id] = control.value;
      state.page = 1;
      writeState();
      load();
    });

    return el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: id, text: label }),
      control,
    ]);
  }

  function row(item) {
    return el('tr', {}, [
      el('td', {}, [
        el('div', {}, [
          el('a', {
            class: 'person__name',
            href: `/attendance/session?id=${encodeURIComponent(item.id)}`,
            text: item.title,
          }),
          el('div', { class: 'person__meta' }, [
            humanise(item.sessionType),
            item.ministryName ? ` · ${item.ministryName}` : '',
          ]),
        ]),
      ]),
      el('td', { class: 'text-sm', text: formatDate(item.sessionDate) }),
      el('td', {}, [
        el('span', {
          class: `pill pill--${item.status === 'open' ? 'brand' : 'neutral'}`,
          text: item.status === 'open' ? 'Open' : 'Closed',
        }),
      ]),
      el('td', { class: 'data-table__numeric text-sm', text: String(item.headcountTotal ?? 0) }),
      el('td', { class: 'data-table__numeric text-sm' }, [
        item.namedCount === null
          ? el('span', { class: 'text-muted-token', text: '—' })
          : el('span', { text: String(item.namedCount) }),
      ]),
    ]);
  }

  function table(rows) {
    return el('div', { class: 'data-table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('caption', {
          class: 'text-xs',
          text: 'Counted is the headcount taken at the door. Identified is how many were recorded by name.',
        }),
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: 'Session' }),
            el('th', { scope: 'col', text: 'Date' }),
            el('th', { scope: 'col', text: 'Status' }),
            el('th', { scope: 'col', class: 'data-table__numeric', text: 'Counted' }),
            el('th', { scope: 'col', class: 'data-table__numeric', text: 'Identified' }),
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
      const payload = await api.get('/attendance/sessions', {
        query: {
          sessionType: state.sessionType || undefined,
          status: state.status || undefined,
          from: state.from || undefined,
          to: state.to || undefined,
          page: state.page,
        },
      });
      if (inFlight !== token) return;

      const sessions = payload.data;
      const filtered = state.sessionType || state.status || state.from || state.to;

      render(resultsRegion, [
        sessions.length === 0
          ? stateBlock({
              iconName: filtered ? 'search' : 'calendar-check',
              title: filtered ? 'No sessions match those filters' : 'No attendance sessions yet',
              message: filtered
                ? 'Try a wider date range, or clear the filters.'
                : 'Open a session to start taking attendance.',
              action: can('attendance.session.create')
                ? el('a', {
                    class: 'btn btn-primary',
                    href: '/attendance/new',
                    text: 'Open a session',
                  })
                : null,
            })
          : table(sessions),
        sessions.length === 0
          ? null
          : paginationControl({
              meta: payload.meta,
              label: 'sessions',
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
          title: 'Could not load attendance sessions',
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
    load();
  });

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'Attendance' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'Registers for services, ministry meetings, and events.',
        }),
      ]),
      can('attendance.session.create')
        ? el('div', { class: 'page-header__actions' }, [
            el('a', { class: 'btn btn-primary', href: '/attendance/new' }, [
              icon('plus-lg'),
              ' Open a session',
            ]),
          ])
        : null,
    ]),
    el('section', { class: 'card-surface' }, [
      el('div', { class: 'filter-bar' }, [
        filterControl({
          id: 'sessionType',
          label: 'Kind',
          options: TYPES,
          blank: 'Any kind',
        }),
        filterControl({
          id: 'status',
          label: 'Status',
          options: ['open', 'closed'],
          blank: 'Any status',
        }),
        filterControl({ id: 'from', label: 'From', type: 'date' }),
        filterControl({ id: 'to', label: 'To', type: 'date' }),
      ]),
      resultsRegion,
    ]),
  ]);

  writeState({ replace: true });
  await load();
}
