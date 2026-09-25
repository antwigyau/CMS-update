/**
 * The approval queue.
 *
 * Everything here is `pending_approval`. Reviewing happens on the detail page,
 * where the server has already decided whether this caller may approve — in
 * particular, the person who submitted a transaction never sees Approve on it
 * (the two-signature rule). So this page links each item to its detail rather than
 * approving inline, which keeps that one decision in one place.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, stateBlock } from '../core/dom.js';
import { formatDate, formatMoney, humanise } from '../core/format.js';
import { can, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { paginationControl } from '../components/pagination.js';

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/finance/approvals',
    title: 'Approvals',
    user: session.user,
    can,
    onSignOut: signOut,
  });

  const resultsRegion = el('div');
  let page = Math.max(
    1,
    Number.parseInt(new URLSearchParams(location.search).get('page') ?? '1', 10) || 1,
  );

  const detailHref = (txn) => `/finance/detail?id=${encodeURIComponent(txn.id)}`;

  function row(txn) {
    const who =
      txn.kind === 'income' ? (txn.isAnonymous ? 'Anonymous' : (txn.memberName ?? '—')) : '—';
    return el('tr', {}, [
      el('td', { class: 'text-sm', text: formatDate(txn.occurredOn) }),
      el('td', {}, [
        el('div', {}, [
          el('a', { class: 'person__name', href: detailHref(txn), text: txn.categoryName ?? '—' }),
          el('div', { class: 'person__meta' }, [
            humanise(txn.kind),
            txn.incomeType ? ` · ${humanise(txn.incomeType)}` : '',
          ]),
        ]),
      ]),
      el('td', { class: 'text-sm', text: who }),
      el('td', { class: 'data-table__numeric', text: formatMoney(txn.amount, txn.currency) }),
      el('td', {}, [
        el('a', { class: 'btn btn-sm btn-primary', href: detailHref(txn) }, [
          icon('eye'),
          ' Review',
        ]),
      ]),
    ]);
  }

  async function load() {
    resultsRegion.setAttribute('aria-busy', 'true');
    try {
      const payload = await api.get('/transactions', {
        query: { status: 'pending_approval', page },
      });
      const transactions = payload.data;

      if (transactions.length === 0) {
        render(resultsRegion, [
          stateBlock({
            iconName: 'check2-all',
            title: 'Nothing waiting for approval',
            message: 'When a transaction is submitted, it appears here.',
          }),
        ]);
        return;
      }

      render(resultsRegion, [
        el('div', { class: 'data-table-wrap' }, [
          el('table', { class: 'data-table' }, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', { scope: 'col', text: 'Date' }),
                el('th', { scope: 'col', text: 'Category' }),
                el('th', { scope: 'col', text: 'Member' }),
                el('th', { scope: 'col', class: 'data-table__numeric', text: 'Amount' }),
                el('th', { scope: 'col' }, [el('span', { class: 'sr-only', text: 'Review' })]),
              ]),
            ]),
            el('tbody', {}, transactions.map(row)),
          ]),
        ]),
        paginationControl({
          meta: payload.meta,
          label: 'transactions',
          onChange: (next) => {
            page = next;
            load();
            document.getElementById('main-content')?.focus();
          },
        }),
      ]);
    } catch (error) {
      render(resultsRegion, [
        stateBlock({
          variant: 'error',
          title: 'Could not load the approval queue',
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
      resultsRegion.removeAttribute('aria-busy');
    }
  }

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'Approvals' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'Transactions waiting for a second signature before they count.',
        }),
      ]),
      el('div', { class: 'page-header__actions' }, [
        el('a', { class: 'btn btn-outline-secondary', href: '/finance' }, [
          icon('arrow-left'),
          ' All transactions',
        ]),
      ]),
    ]),
    el('section', { class: 'card-surface' }, [
      el('div', { class: 'card-surface__body' }, [resultsRegion]),
    ]),
  ]);

  await load();
}
