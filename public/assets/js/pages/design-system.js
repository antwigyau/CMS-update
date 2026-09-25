/**
 * Design system reference — a local development page, excluded from deployment
 * by .vercelignore.
 *
 * It has two jobs:
 *   1. show every shared component in light and dark so regressions are visible
 *   2. act as a smoke test — the shell, dom helpers, theme, toasts, and the API
 *      client are all the real modules, and the health card performs a real
 *      request to /api/health
 *
 * Note the absence of inline styles: the CSP blocks style="" attributes, and
 * el() throws if you try. Page-specific classes live in css/design-system.css.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, skeletonLines, stateBlock } from '../core/dom.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';

const { main } = renderShell({
  mount: document.getElementById('app'),
  active: '/dashboard',
  title: 'Design system',
  churchName: 'Church Manager',
  user: { fullName: 'Design reference' },
});

function section(title, description, children) {
  return el('section', { class: 'card-surface gap-below-5' }, [
    el('div', { class: 'card-surface__header' }, [
      el('h2', { class: 'card-surface__title', text: title }),
      description ? el('span', { class: 'text-xs text-muted-token', text: description }) : null,
    ]),
    el('div', { class: 'card-surface__body' }, children),
  ]);
}

function swatch(token) {
  return el('div', { class: 'stack-2' }, [
    el('div', { class: `swatch ds-swatch--${token}` }),
    el('div', { class: 'text-xs mono', text: `--${token}` }),
  ]);
}

/* ---- health card: a real request to the real API ------------------------- */

function healthCard() {
  const body = el('div', {}, [skeletonLines(2)]);
  const card = section('API connectivity', 'GET /api/health', [body]);

  api
    .get('/health')
    .then((payload) => {
      const health = payload.data;
      render(body, [
        el('div', { class: 'cluster' }, [
          el('span', { class: 'pill pill--success' }, [icon('check-circle'), ` ${health.status}`]),
          el('span', { class: 'pill pill--neutral', text: `v${health.version}` }),
          el('span', { class: 'pill pill--neutral', text: health.deployment }),
          el('span', {
            class: `pill ${health.supabase.configured ? 'pill--brand' : 'pill--warning'}`,
            text: health.supabase.configured ? 'supabase configured' : 'supabase not configured',
          }),
        ]),
        el('p', { class: 'text-xs text-muted-token gap-above-3', text: health.time }),
      ]);
    })
    .catch((error) => {
      render(body, [
        stateBlock({
          variant: 'error',
          title: 'Could not reach the API',
          message: error instanceof ApiError ? `${error.code}: ${error.message}` : String(error),
        }),
      ]);
    });

  return card;
}

/* ---- page --------------------------------------------------------------- */

render(main, [
  el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', { class: 'page-header__title', text: 'Design system' }),
      el('p', {
        class: 'page-header__subtitle',
        text: 'Shared tokens and components. Toggle the theme in the top bar to check both modes.',
      }),
    ]),
  ]),

  healthCard(),

  section('Surfaces and text', 'semantic tokens', [
    el('div', { class: 'grid-auto' }, [
      swatch('surface-page'),
      swatch('surface-card'),
      swatch('surface-sunken'),
      swatch('brand'),
      swatch('brand-soft'),
      swatch('border-subtle'),
    ]),
    el('div', { class: 'stack-2 gap-above-5' }, [
      el('p', { class: 'text-primary-token', text: 'Primary text — 17.9:1 on card in light mode' }),
      el('p', { class: 'text-secondary-token', text: 'Secondary text — 7.6:1' }),
      el('p', {
        class: 'text-muted-token',
        text: 'Muted text — 4.8:1, the lowest pair in the system',
      }),
    ]),
  ]),

  section('Buttons', null, [
    el('div', { class: 'cluster' }, [
      el('button', { class: 'btn btn-primary', type: 'button', text: 'Primary action' }),
      el('button', { class: 'btn btn-outline-secondary', type: 'button', text: 'Secondary' }),
      el('button', { class: 'btn btn-primary', type: 'button', text: 'Disabled', disabled: true }),
      el(
        'button',
        { class: 'btn btn-outline-secondary btn-icon', type: 'button', 'aria-label': 'Edit' },
        [icon('pencil')],
      ),
    ]),
  ]),

  section('Form controls', 'labels, hints, and error states', [
    el('div', { class: 'grid-auto' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', for: 'ds-name', text: 'Full name' }),
        el('input', { class: 'form-control', id: 'ds-name', type: 'text', value: 'Grace Mensah' }),
        el('p', { class: 'field__hint', text: 'As it should appear on the membership roll.' }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', for: 'ds-status', text: 'Membership status' }),
        el('select', { class: 'form-select', id: 'ds-status' }, [
          el('option', { text: 'Active' }),
          el('option', { text: 'Inactive' }),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field__label', for: 'ds-phone', text: 'Phone' }),
        el('input', {
          class: 'form-control',
          id: 'ds-phone',
          type: 'tel',
          value: 'not a number',
          'aria-invalid': 'true',
          'aria-describedby': 'ds-phone-error',
        }),
        el('p', {
          class: 'field__error',
          id: 'ds-phone-error',
          text: 'Enter a valid phone number.',
        }),
      ]),
    ]),
  ]),

  section('Status pills', 'the finance lifecycle uses these', [
    el('div', { class: 'cluster' }, [
      el('span', { class: 'pill pill--neutral', text: 'Draft' }),
      el('span', { class: 'pill pill--warning', text: 'Pending approval' }),
      el('span', { class: 'pill pill--success', text: 'Approved' }),
      el('span', { class: 'pill pill--danger', text: 'Rejected' }),
      el('span', { class: 'pill pill--brand', text: 'Active' }),
    ]),
  ]),

  section('Table', 'sticky header, tabular numerals, hover row', [
    el('div', { class: 'data-table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('caption', { text: 'Illustrative rows only — not real data.' }),
        el('thead', {}, [
          el('tr', {}, [
            el('th', { scope: 'col', text: 'Member no.' }),
            el('th', { scope: 'col', text: 'Name' }),
            el('th', { scope: 'col', text: 'Status' }),
            el('th', { scope: 'col', class: 'data-table__numeric', text: 'Attendance' }),
          ]),
        ]),
        el(
          'tbody',
          {},
          [
            ['MB-000101', 'Grace Mensah', 'Active', '42'],
            ['MB-000102', 'Daniel Osei', 'Active', '38'],
            ['MB-000103', 'Abena Owusu', 'Inactive', '4'],
          ].map(([number, name, status, count]) =>
            el('tr', {}, [
              el('td', { class: 'mono text-xs', text: number }),
              el('td', { text: name }),
              el('td', {}, [
                el('span', {
                  class: `pill ${status === 'Active' ? 'pill--success' : 'pill--neutral'}`,
                  text: status,
                }),
              ]),
              el('td', { class: 'data-table__numeric', text: count }),
            ]),
          ),
        ),
      ]),
    ]),
  ]),

  section('Empty, error, and loading states', 'every list needs all three', [
    el('div', { class: 'grid-auto' }, [
      el('div', { class: 'card-surface' }, [
        stateBlock({
          title: 'No members yet',
          message: 'Add the first member to start building the roll.',
          action: el('button', { class: 'btn btn-primary', type: 'button', text: 'Add member' }),
        }),
      ]),
      el('div', { class: 'card-surface' }, [
        stateBlock({
          variant: 'error',
          title: 'Could not load members',
          message:
            'The request failed. Try again, and quote reference 8f21c4 if it keeps happening.',
          action: el('button', {
            class: 'btn btn-outline-secondary',
            type: 'button',
            text: 'Retry',
          }),
        }),
      ]),
      el('div', { class: 'card-surface' }, [
        el('div', { class: 'card-surface__body' }, [
          el('div', { class: 'skeleton skeleton--title' }),
          skeletonLines(4),
        ]),
      ]),
    ]),
  ]),

  section('Notifications', 'polite for success, assertive for errors', [
    el('div', { class: 'cluster' }, [
      el('button', {
        class: 'btn btn-outline-secondary',
        type: 'button',
        text: 'Success toast',
        onclick: () => notify.success('Member saved.'),
      }),
      el('button', {
        class: 'btn btn-outline-secondary',
        type: 'button',
        text: 'Error toast',
        onclick: () => notify.error('Could not save the member. Nothing was changed.'),
      }),
      el('button', {
        class: 'btn btn-outline-secondary',
        type: 'button',
        text: 'Warning toast',
        onclick: () => notify.warning('This transaction still needs approval.'),
      }),
    ]),
  ]),
]);
