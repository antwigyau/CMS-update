/**
 * The shared scaffold behind every report page.
 *
 * Each report differs only in its filters, its summary endpoint, and how it draws
 * the numbers — so those are the config a page passes in, and everything else
 * (the shell, the filter bar, URL-synced state, loading and error states, the CSV
 * button) lives here once. It mirrors the list pages' "state in the URL" pattern
 * (ADR-036) so a filtered report is a shareable link.
 */

import { ApiError, api } from '../core/api.js';
import { el, render, stateBlock, skeletonLines } from '../core/dom.js';
import { can, currency, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { csvButton } from '../components/report-viz.js';

/**
 * @param {object} config
 * @param {string} config.title            Top-bar label.
 * @param {string} config.heading          Page H1.
 * @param {string} [config.subtitle]
 * @param {string} config.summaryPath      API path for the summary JSON.
 * @param {string} config.exportPath       API path for the CSV.
 * @param {{name,label,type,options?}[]} [config.filters]
 * @param {(summary, ctx) => Array} config.render  ctx = { currency }.
 */
export async function mountReport(config) {
  const session = await requireSession();
  if (!session) return;

  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/reports',
    title: config.title,
    user: session.user,
    can,
    onSignOut: signOut,
  });

  const filters = config.filters ?? [];
  const state = readState();
  const filterRegion = el('div', { class: 'filter-bar' });
  const resultsRegion = el('div');
  let inFlight = null;

  function readState() {
    const params = new URLSearchParams(location.search);
    return Object.fromEntries(
      filters.map((filter) => [filter.name, params.get(filter.name) ?? '']),
    );
  }

  function writeState() {
    const params = new URLSearchParams();
    for (const filter of filters) {
      if (state[filter.name]) params.set(filter.name, state[filter.name]);
    }
    const url = `${location.pathname}${params.toString() ? `?${params}` : ''}`;
    history.replaceState(null, '', url);
  }

  function activeQuery() {
    const query = {};
    for (const filter of filters) {
      if (state[filter.name]) query[filter.name] = state[filter.name];
    }
    return query;
  }

  function field(filter) {
    if (filter.type === 'select') {
      const select = el(
        'select',
        { class: 'form-select', id: `report-${filter.name}`, 'aria-label': filter.label },
        filter.options.map((option) => el('option', { value: option.value, text: option.label })),
      );
      select.value = state[filter.name];
      select.addEventListener('change', () => {
        state[filter.name] = select.value;
        writeState();
        load();
      });
      return control(filter, select);
    }

    const input = el('input', {
      class: 'form-control',
      id: `report-${filter.name}`,
      type: 'date',
      value: state[filter.name],
    });
    input.addEventListener('change', () => {
      state[filter.name] = input.value;
      writeState();
      load();
    });
    return control(filter, input);
  }

  function control(filter, node) {
    return el('div', { class: 'field' }, [
      el('label', { class: 'field__label', for: `report-${filter.name}`, text: filter.label }),
      node,
    ]);
  }

  function renderFilters() {
    render(filterRegion, filters.map(field));
  }

  async function load() {
    const token = {};
    inFlight = token;

    render(resultsRegion, [el('div', { class: 'card-surface__body' }, [skeletonLines(4)])]);
    resultsRegion.setAttribute('aria-busy', 'true');

    try {
      const payload = await api.get(config.summaryPath, { query: activeQuery() });
      if (inFlight !== token) return;
      render(resultsRegion, config.render(payload.data, { currency: currency() }));
    } catch (error) {
      if (inFlight !== token) return;
      render(resultsRegion, [
        stateBlock({
          variant: 'error',
          title: 'Could not load this report',
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
        el('a', { class: 'text-sm text-muted-token', href: '/reports', text: '← All reports' }),
        el('h1', { class: 'page-header__title', text: config.heading }),
        config.subtitle ? el('p', { class: 'page-header__subtitle', text: config.subtitle }) : null,
      ]),
      el('div', { class: 'page-header__actions' }, [
        csvButton({ path: config.exportPath, query: activeQuery }),
      ]),
    ]),
    filters.length ? el('section', { class: 'card-surface' }, [filterRegion]) : null,
    el('section', { class: 'card-surface' }, [
      el('div', { class: 'card-surface__body' }, [resultsRegion]),
    ]),
  ]);

  if (filters.length) renderFilters();
  await load();
}
