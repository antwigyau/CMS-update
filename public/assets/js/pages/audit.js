/**
 * The audit log viewer.
 *
 * Read-only by nature — there is no way to write or delete a row from here, which
 * matches the table (append-only, enforced by triggers for every role). State
 * lives in the URL so a filtered view is a shareable link (ADR-036).
 */

import { ApiError, api } from '../core/api.js';
import { el, render, skeletonLines, stateBlock } from '../core/dom.js';
import { formatDateTime, humanise } from '../core/format.js';
import { can, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { paginationControl } from '../components/pagination.js';

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/admin/audit',
    title: 'Audit log',
    user: session.user,
    can,
    onSignOut: signOut,
  });

  const state = readState();
  const filterRegion = el('div', { class: 'filter-bar' });
  const resultsRegion = el('div');
  let inFlight = null;

  function readState() {
    const params = new URLSearchParams(location.search);
    return {
      action: params.get('action') ?? '',
      resourceType: params.get('resourceType') ?? '',
      from: params.get('from') ?? '',
      to: params.get('to') ?? '',
      page: Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1),
    };
  }

  function writeState() {
    const params = new URLSearchParams();
    for (const key of ['action', 'resourceType', 'from', 'to']) {
      if (state[key]) params.set(key, state[key]);
    }
    if (state.page > 1) params.set('page', String(state.page));
    history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}`);
  }

  function textFilter(id, label, key, placeholder) {
    const input = el('input', {
      class: 'form-control',
      id,
      type: 'search',
      placeholder,
      value: state[key],
    });
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state[key] = input.value.trim();
        state.page = 1;
        writeState();
        load();
      }, 250);
    });
    return el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: id, text: label }),
      input,
    ]);
  }

  function dateFilter(id, label, key) {
    const input = el('input', { class: 'form-control', id, type: 'date', value: state[key] });
    input.addEventListener('change', () => {
      state[key] = input.value;
      state.page = 1;
      writeState();
      load();
    });
    return el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: id, text: label }),
      input,
    ]);
  }

  function renderFilters() {
    render(filterRegion, [
      textFilter('audit-action', 'Action', 'action', 'e.g. transaction.approved'),
      textFilter('audit-resource', 'Resource', 'resourceType', 'e.g. member'),
      dateFilter('audit-from', 'From', 'from'),
      dateFilter('audit-to', 'To', 'to'),
    ]);
  }

  function row(entry) {
    const changes =
      entry.changes && typeof entry.changes === 'object' ? JSON.stringify(entry.changes) : '';
    return el('tr', {}, [
      el('td', { class: 'text-sm', text: formatDateTime(entry.occurredAt) }),
      el('td', { class: 'text-sm', text: entry.actorName ?? entry.actorEmail ?? '—' }),
      el('td', {}, [el('span', { class: 'mono text-xs', text: entry.action })]),
      el('td', { class: 'text-sm' }, [
        `${humanise(entry.resourceType)}`,
        entry.resourceId
          ? el('div', { class: 'text-xs text-muted-token mono', text: entry.resourceId })
          : null,
      ]),
      el('td', { class: 'text-xs text-muted-token', text: changes }),
    ]);
  }

  function table(entries) {
    return el('div', { class: 'data-table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: 'When' }),
            el('th', { scope: 'col', text: 'Who' }),
            el('th', { scope: 'col', text: 'Action' }),
            el('th', { scope: 'col', text: 'Resource' }),
            el('th', { scope: 'col', text: 'Details' }),
          ]),
        ]),
        el('tbody', {}, entries.map(row)),
      ]),
    ]);
  }

  async function load() {
    const token = {};
    inFlight = token;
    render(resultsRegion, [el('div', { class: 'card-surface__body' }, [skeletonLines(5)])]);
    resultsRegion.setAttribute('aria-busy', 'true');

    try {
      const payload = await api.get('/admin/audit', {
        query: {
          action: state.action || undefined,
          resourceType: state.resourceType || undefined,
          from: state.from || undefined,
          to: state.to || undefined,
          page: state.page,
        },
      });
      if (inFlight !== token) return;

      const entries = payload.data;
      if (entries.length === 0) {
        render(resultsRegion, [
          stateBlock({
            iconName: 'journal-text',
            title: 'No audit entries match those filters',
            message: 'Actions are recorded here as they happen.',
          }),
        ]);
        return;
      }

      render(resultsRegion, [
        table(entries),
        paginationControl({
          meta: payload.meta,
          label: 'entries',
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
          title: 'Could not load the audit log',
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

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'Audit log' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'Who did what, and when. Append-only — entries can never be edited or removed.',
        }),
      ]),
    ]),
    el('section', { class: 'card-surface' }, [filterRegion, resultsRegion]),
  ]);

  renderFilters();
  writeState();
  await load();
}
