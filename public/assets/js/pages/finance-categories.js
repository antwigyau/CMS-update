/**
 * Transaction categories admin.
 *
 * Categories are the shared vocabulary a ledger groups by, so they are managed in
 * one place rather than typed free-hand per transaction. A category is never
 * deleted once used — it is deactivated, which keeps historical transactions
 * legible while hiding it from new ones.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, skeletonLines, stateBlock } from '../core/dom.js';
import { humanise } from '../core/format.js';
import { requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';

const account = await requireSession();

if (account) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/finance',
    title: 'Transaction categories',
    user: account.user,
    can: (permission) => account.permissions.includes(permission),
    onSignOut: signOut,
  });

  const listRegion = el('div');

  function reportError(error, fallback) {
    const fields = error instanceof ApiError ? (error.details?.fields ?? {}) : {};
    const first = Object.values(fields)[0];
    notify.error(first ?? (error instanceof ApiError ? error.message : fallback));
  }

  async function createCategory(kind) {
    const name = window.prompt(`Name for the new ${kind} category:`);
    if (name === null) return;
    if (name.trim().length < 2) {
      notify.warning('A name of at least 2 characters is needed.');
      return;
    }
    try {
      await api.post('/transaction-categories', { kind, name: name.trim() });
      notify.success('Category added.');
      await load();
    } catch (error) {
      reportError(error, 'Could not add that category.');
    }
  }

  async function rename(category) {
    const name = window.prompt('New name:', category.name);
    if (name === null || name.trim() === category.name) return;
    if (name.trim().length < 2) {
      notify.warning('A name of at least 2 characters is needed.');
      return;
    }
    try {
      await api.patch(`/transaction-categories/${encodeURIComponent(category.id)}`, {
        name: name.trim(),
      });
      await load();
    } catch (error) {
      reportError(error, 'Could not rename that category.');
    }
  }

  async function toggleActive(category) {
    try {
      await api.patch(`/transaction-categories/${encodeURIComponent(category.id)}`, {
        isActive: !category.isActive,
      });
      await load();
    } catch (error) {
      reportError(error, 'Could not update that category.');
    }
  }

  function categoryRow(category) {
    return el('tr', {}, [
      el('td', {}, [
        el('span', { class: 'person__name', text: category.name }),
        category.code
          ? el('span', { class: 'person__meta mono', text: ` ${category.code}` })
          : null,
      ]),
      el('td', {}, [
        category.isActive
          ? el('span', { class: 'pill pill--success', text: 'Active' })
          : el('span', { class: 'pill pill--neutral', text: 'Retired' }),
      ]),
      el('td', {}, [
        el('button', {
          class: 'btn btn-sm btn-outline-secondary',
          type: 'button',
          text: 'Rename',
          onclick: () => rename(category),
        }),
        ' ',
        el('button', {
          class: 'btn btn-sm btn-outline-secondary',
          type: 'button',
          text: category.isActive ? 'Retire' : 'Reactivate',
          onclick: () => toggleActive(category),
        }),
      ]),
    ]);
  }

  function kindTable(kind, categories) {
    const forKind = categories.filter((category) => category.kind === kind);
    return el('section', { class: 'card-surface gap-below-5' }, [
      el('div', { class: 'card-surface__header' }, [
        el('h2', { class: 'card-surface__title', text: `${humanise(kind)} categories` }),
        el(
          'button',
          {
            class: 'btn btn-sm btn-primary push-right',
            type: 'button',
            onclick: () => createCategory(kind),
          },
          [icon('plus-lg'), ' Add'],
        ),
      ]),
      forKind.length === 0
        ? stateBlock({
            iconName: 'tags',
            title: `No ${kind} categories yet`,
            message: 'Add one to start.',
          })
        : el('div', { class: 'data-table-wrap' }, [
            el('table', { class: 'data-table' }, [
              el('thead', {}, [
                el('tr', {}, [
                  el('th', { scope: 'col', text: 'Name' }),
                  el('th', { scope: 'col', text: 'Status' }),
                  el('th', { scope: 'col' }, [el('span', { class: 'sr-only', text: 'Actions' })]),
                ]),
              ]),
              el('tbody', {}, forKind.map(categoryRow)),
            ]),
          ]),
    ]);
  }

  async function load() {
    try {
      const { data: categories } = await api.get('/transaction-categories', {
        query: { all: '1' },
      });
      render(listRegion, [kindTable('income', categories), kindTable('expense', categories)]);
    } catch (error) {
      render(listRegion, [
        stateBlock({
          variant: 'error',
          title: 'Could not load categories',
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
    }
  }

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'Transaction categories' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'The income and expense categories the ledger groups by.',
        }),
      ]),
      el('div', { class: 'page-header__actions' }, [
        el('a', { class: 'btn btn-outline-secondary', href: '/finance' }, [
          icon('arrow-left'),
          ' Back',
        ]),
      ]),
    ]),
    listRegion,
  ]);

  render(listRegion, [el('div', { class: 'card-surface__body' }, [skeletonLines(4)])]);
  await load();
}
