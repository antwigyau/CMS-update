/**
 * Events, as a month calendar or a list.
 *
 * The calendar is the default because that is how people think about what is
 * coming up. The list is not a lesser fallback — it is the accessible view, and it
 * is what a narrow screen gets, so it carries the same information with dates,
 * statuses, and registration counts spelled out.
 *
 * Both views read the same URL state, so switching preserves the month.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, stateBlock } from '../core/dom.js';
import { EVENT_STATUS_VARIANT, formatEventWhen, humanise } from '../core/format.js';
import { can, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { monthCalendar, monthLabel, monthWindow } from '../components/calendar.js';
import { paginationControl } from '../components/pagination.js';

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/events',
    title: 'Events',
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
    const now = new Date();
    return {
      view: params.get('view') === 'list' ? 'list' : 'calendar',
      year: Number.parseInt(params.get('year') ?? '', 10) || now.getFullYear(),
      month: Number.isInteger(Number.parseInt(params.get('month') ?? '', 10))
        ? Number.parseInt(params.get('month'), 10)
        : now.getMonth(),
      status: params.get('status') ?? '',
      categoryId: params.get('categoryId') ?? '',
      page: Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1),
    };
  }

  function writeState({ replace = false } = {}) {
    const params = new URLSearchParams();
    if (state.view !== 'calendar') params.set('view', state.view);
    if (state.status) params.set('status', state.status);
    if (state.categoryId) params.set('categoryId', state.categoryId);

    if (state.view === 'calendar') {
      params.set('year', String(state.year));
      params.set('month', String(state.month));
    } else if (state.page > 1) {
      params.set('page', String(state.page));
    }

    const url = `${location.pathname}${params.toString() ? `?${params}` : ''}`;
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }

  function shiftMonth(delta) {
    const moved = new Date(state.year, state.month + delta, 1);
    state.year = moved.getFullYear();
    state.month = moved.getMonth();
    writeState();
    renderHeader();
    load();
  }

  /* ---- header ----------------------------------------------------------- */

  function renderHeader() {
    const statusSelect = el(
      'select',
      { class: 'form-select', id: 'events-status', 'aria-label': 'Status' },
      [
        el('option', { value: '', text: 'Any status', selected: state.status === '' }),
        ...['draft', 'published', 'ongoing', 'completed', 'cancelled'].map((value) =>
          el('option', { value, text: humanise(value), selected: state.status === value }),
        ),
      ],
    );
    statusSelect.addEventListener('change', () => {
      state.status = statusSelect.value;
      state.page = 1;
      writeState();
      load();
    });

    const categorySelect = el(
      'select',
      { class: 'form-select', id: 'events-category', 'aria-label': 'Category' },
      [
        el('option', { value: '', text: 'Any category', selected: state.categoryId === '' }),
        ...categories.map((category) =>
          el('option', {
            value: category.id,
            text: category.name,
            selected: state.categoryId === category.id,
          }),
        ),
      ],
    );
    categorySelect.addEventListener('change', () => {
      state.categoryId = categorySelect.value;
      state.page = 1;
      writeState();
      load();
    });

    function viewButton(view, label, iconName) {
      return el(
        'button',
        {
          class: `btn btn-sm ${state.view === view ? 'btn-primary' : 'btn-outline-secondary'}`,
          type: 'button',
          'aria-pressed': String(state.view === view),
          onclick: () => {
            state.view = view;
            state.page = 1;
            writeState();
            renderHeader();
            load();
          },
        },
        [icon(iconName), ` ${label}`],
      );
    }

    render(headerRegion, [
      state.view === 'calendar'
        ? el('div', { class: 'cluster' }, [
            el(
              'button',
              {
                class: 'btn btn-sm btn-outline-secondary btn-icon',
                type: 'button',
                'aria-label': 'Previous month',
                onclick: () => shiftMonth(-1),
              },
              [icon('chevron-left')],
            ),
            el('strong', { text: monthLabel(state.year, state.month) }),
            el(
              'button',
              {
                class: 'btn btn-sm btn-outline-secondary btn-icon',
                type: 'button',
                'aria-label': 'Next month',
                onclick: () => shiftMonth(1),
              },
              [icon('chevron-right')],
            ),
            el('button', {
              class: 'btn btn-sm btn-outline-secondary',
              type: 'button',
              text: 'Today',
              onclick: () => {
                const now = new Date();
                state.year = now.getFullYear();
                state.month = now.getMonth();
                writeState();
                renderHeader();
                load();
              },
            }),
          ])
        : el('div', {}),
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', for: 'events-status', text: 'Status' }),
        statusSelect,
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', for: 'events-category', text: 'Category' }),
        categorySelect,
      ]),
      el('div', { class: 'view-toggle push-right' }, [
        viewButton('calendar', 'Calendar', 'calendar3'),
        viewButton('list', 'List', 'list-ul'),
      ]),
    ]);
  }

  /* ---- views ------------------------------------------------------------ */

  const eventHref = (event) => `/events/detail?id=${encodeURIComponent(event.id)}`;

  function listRow(event) {
    return el('tr', {}, [
      el('td', {}, [
        el('div', {}, [
          el('a', { class: 'person__name', href: eventHref(event), text: event.title }),
          el('div', { class: 'person__meta' }, [
            event.categoryName ?? 'Uncategorised',
            event.ministryName ? ` · ${event.ministryName}` : '',
          ]),
        ]),
      ]),
      el('td', { class: 'text-sm', text: formatEventWhen(event.startsAt, event.endsAt) }),
      el('td', { class: 'text-sm', text: event.venue ?? '—' }),
      el('td', {}, [
        el('span', {
          class: `pill pill--${EVENT_STATUS_VARIANT[event.status] ?? 'neutral'}`,
          text: humanise(event.status),
        }),
      ]),
      el('td', { class: 'data-table__numeric text-sm' }, [
        event.registeredCount === null
          ? el('span', { class: 'text-muted-token', text: '—' })
          : el('span', {
              text: event.capacity
                ? `${event.registeredCount} / ${event.capacity}`
                : String(event.registeredCount),
            }),
      ]),
    ]);
  }

  function listView(events) {
    return el('div', { class: 'data-table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: 'Event' }),
            el('th', { scope: 'col', text: 'When' }),
            el('th', { scope: 'col', text: 'Venue' }),
            el('th', { scope: 'col', text: 'Status' }),
            el('th', { scope: 'col', class: 'data-table__numeric', text: 'Registered' }),
          ]),
        ]),
        el('tbody', {}, events.map(listRow)),
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

    // The calendar needs a whole month at once; the list pages normally.
    const window_ = state.view === 'calendar' ? monthWindow(state.year, state.month) : {};

    try {
      const payload = await api.get('/events', {
        query: {
          status: state.status || undefined,
          categoryId: state.categoryId || undefined,
          from: window_.from,
          to: window_.to,
          page: state.view === 'calendar' ? 1 : state.page,
          pageSize: state.view === 'calendar' ? 100 : undefined,
        },
      });
      if (inFlight !== token) return;

      const events = payload.data;

      if (events.length === 0) {
        render(resultsRegion, [
          stateBlock({
            iconName: 'calendar-event',
            title:
              state.view === 'calendar'
                ? `Nothing scheduled in ${monthLabel(state.year, state.month)}`
                : 'No events match those filters',
            message: can('events.create')
              ? 'Create an event to put it on the calendar.'
              : 'Nothing to show here yet.',
            action: can('events.create')
              ? el('a', { class: 'btn btn-primary', href: '/events/new', text: 'Add event' })
              : null,
          }),
        ]);
        return;
      }

      render(resultsRegion, [
        state.view === 'calendar'
          ? monthCalendar({ year: state.year, month: state.month, events, href: eventHref })
          : listView(events),
        state.view === 'list'
          ? paginationControl({
              meta: payload.meta,
              label: 'events',
              onChange: (page) => {
                state.page = page;
                writeState();
                load();
                document.getElementById('main-content')?.focus();
              },
            })
          : null,
      ]);
    } catch (error) {
      if (inFlight !== token) return;
      render(resultsRegion, [
        stateBlock({
          variant: 'error',
          title: 'Could not load events',
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
        el('h1', { class: 'page-header__title', text: 'Events' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'Services, conferences, and everything else on the church calendar.',
        }),
      ]),
      can('events.create')
        ? el('div', { class: 'page-header__actions' }, [
            el('a', { class: 'btn btn-primary', href: '/events/new' }, [
              icon('plus-lg'),
              ' Add event',
            ]),
          ])
        : null,
    ]),
    el('section', { class: 'card-surface' }, [headerRegion, resultsRegion]),
  ]);

  renderHeader();
  writeState({ replace: true });

  // Categories populate the filter. A failure is not fatal — the filter simply
  // offers "any category" — so it does not block the events themselves.
  api
    .get('/event-categories')
    .then((payload) => {
      categories = payload.data;
      renderHeader();
    })
    .catch(() => {});

  await load();
}
