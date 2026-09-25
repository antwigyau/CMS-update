/**
 * Transaction detail, and the lifecycle controls.
 *
 * The action buttons come from `canSubmit`, `canApprove`, `canReject`, `canVoid`,
 * and `canEdit` on the response, not from permission names here — the server has
 * already applied the two-signature rule (the submitter never sees Approve), and
 * duplicating that logic would be a second place for it to drift.
 *
 * Rejecting and voiding both need a reason, which the record keeps. A window
 * prompt is deliberately plain: this is a back-office confirmation, not a place for
 * a bespoke modal.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, skeletonLines, stateBlock } from '../core/dom.js';
import {
  TRANSACTION_STATUS_VARIANT,
  formatDate,
  formatDateTime,
  formatMoney,
  humanise,
} from '../core/format.js';
import { requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';

const txnId = new URLSearchParams(location.search).get('id');
const account = await requireSession();

if (account) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/finance',
    title: 'Transaction',
    user: account.user,
    can: (permission) => account.permissions.includes(permission),
    onSignOut: signOut,
  });

  if (!txnId) {
    render(main, [
      stateBlock({
        variant: 'error',
        title: 'No transaction specified',
        message: 'This link is incomplete.',
        action: el('a', { class: 'btn btn-outline-secondary', href: '/finance', text: 'Back' }),
      }),
    ]);
  } else {
    render(main, [el('div', { class: 'card-surface__body' }, [skeletonLines(6)])]);
    await load();
  }

  /* ---- actions ---------------------------------------------------------- */

  function reportError(error, fallback) {
    const fields = error instanceof ApiError ? (error.details?.fields ?? {}) : {};
    const first = Object.values(fields)[0];
    notify.error(first ?? (error instanceof ApiError ? error.message : fallback));
  }

  async function changeStatus(status, { reason } = {}) {
    try {
      const body = { status };
      if (reason !== undefined) body.reason = reason;
      await api.post(`/transactions/${encodeURIComponent(txnId)}/status`, body);
      notify.success(`Transaction ${humanise(status).toLowerCase()}.`);
      await load();
    } catch (error) {
      reportError(error, 'Could not change the transaction status.');
    }
  }

  function submit() {
    return changeStatus('pending_approval');
  }

  function approve() {
    if (!window.confirm('Approve this transaction? Once approved it counts toward the accounts.'))
      return;
    return changeStatus('approved');
  }

  function reject() {
    const reason = window.prompt(
      'Why is this transaction being sent back? (at least 3 characters)',
    );
    if (reason === null) return;
    if (reason.trim().length < 3) {
      notify.warning('A reason of at least 3 characters is needed.');
      return;
    }
    return changeStatus('rejected', { reason: reason.trim() });
  }

  function voidTxn() {
    const reason = window.prompt(
      'Voiding keeps the record but reverses the transaction. Why is it being voided? (at least 3 characters)',
    );
    if (reason === null) return;
    if (reason.trim().length < 3) {
      notify.warning('A reason of at least 3 characters is needed.');
      return;
    }
    return changeStatus('void', { reason: reason.trim() });
  }

  /* ---- rendering -------------------------------------------------------- */

  function definition(term, value) {
    return [
      el('dt', { class: 'detail-list__term', text: term }),
      el('dd', { class: 'detail-list__value', text: value ?? '—' }),
    ];
  }

  function whoRow(txn) {
    if (txn.kind !== 'income') return null;
    if (txn.isAnonymous) return definition('Member', 'Anonymous');
    return definition(
      'Member',
      txn.memberName ? `${txn.memberName} (${txn.memberNo ?? '—'})` : '—',
    );
  }

  function lifecycleNote(txn) {
    if (txn.status === 'rejected' && txn.rejectionReason) {
      return el('div', { class: 'inline-alert inline-alert--warning', role: 'status' }, [
        icon('arrow-counterclockwise'),
        el('span', { text: `Sent back: ${txn.rejectionReason}` }),
      ]);
    }
    if (txn.status === 'void' && txn.voidReason) {
      return el('div', { class: 'inline-alert inline-alert--danger', role: 'status' }, [
        icon('x-octagon'),
        el('span', { text: `Voided: ${txn.voidReason}` }),
      ]);
    }
    if (txn.status === 'draft') {
      return el('div', { class: 'inline-alert inline-alert--info', role: 'status' }, [
        icon('pencil'),
        el('span', {
          text: 'This transaction is a draft. Submit it for approval when it is ready.',
        }),
      ]);
    }
    if (txn.status === 'pending_approval') {
      return el('div', { class: 'inline-alert inline-alert--info', role: 'status' }, [
        icon('hourglass-split'),
        el('span', {
          text: 'Waiting for approval. It does not count until a second person approves it.',
        }),
      ]);
    }
    return null;
  }

  async function load() {
    try {
      const { data: txn } = await api.get(`/transactions/${encodeURIComponent(txnId)}`);

      const actions = [
        el('a', { class: 'btn btn-outline-secondary', href: '/finance', text: 'Back' }),
        txn.canEdit
          ? el(
              'a',
              {
                class: 'btn btn-outline-secondary',
                href: `/finance/edit?id=${encodeURIComponent(txn.id)}`,
              },
              [icon('pencil'), ' Edit'],
            )
          : null,
        txn.canSubmit
          ? el('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, [
              icon('send'),
              ' Submit for approval',
            ])
          : null,
        txn.canApprove
          ? el('button', { class: 'btn btn-primary', type: 'button', onclick: approve }, [
              icon('check2-circle'),
              ' Approve',
            ])
          : null,
        txn.canReject
          ? el('button', { class: 'btn btn-outline-secondary', type: 'button', onclick: reject }, [
              icon('arrow-counterclockwise'),
              ' Send back',
            ])
          : null,
        txn.canVoid
          ? el('button', { class: 'btn btn-outline-secondary', type: 'button', onclick: voidTxn }, [
              icon('x-circle'),
              ' Void',
            ])
          : null,
      ];

      render(main, [
        el('div', { class: 'page-header' }, [
          el('div', {}, [
            el('h1', { class: 'page-header__title', text: formatMoney(txn.amount, txn.currency) }),
            el('p', { class: 'page-header__subtitle' }, [
              el('span', {
                class: `pill pill--${TRANSACTION_STATUS_VARIANT[txn.status] ?? 'neutral'}`,
                text: humanise(txn.status),
              }),
              ` · ${humanise(txn.kind)} · ${txn.categoryName ?? 'Uncategorised'} · ${formatDate(txn.occurredOn)}`,
            ]),
          ]),
          el('div', { class: 'page-header__actions' }, actions),
        ]),

        lifecycleNote(txn),

        el('section', { class: 'card-surface gap-below-5' }, [
          el('div', { class: 'card-surface__header' }, [
            el('h2', { class: 'card-surface__title', text: 'Details' }),
          ]),
          el('div', { class: 'card-surface__body' }, [
            el(
              'dl',
              { class: 'detail-list' },
              [
                definition('Amount', formatMoney(txn.amount, txn.currency)),
                definition('Type', humanise(txn.kind)),
                txn.incomeType ? definition('Income type', humanise(txn.incomeType)) : [],
                definition('Category', txn.categoryName),
                whoRow(txn) ?? [],
                definition('Date', formatDate(txn.occurredOn)),
                definition('Method', humanise(txn.paymentMethod)),
                txn.reference ? definition('Reference', txn.reference) : [],
                txn.submittedAt ? definition('Submitted', formatDateTime(txn.submittedAt)) : [],
                txn.approvedAt ? definition('Approved', formatDateTime(txn.approvedAt)) : [],
              ].flat(),
            ),
            txn.description
              ? el('p', { class: 'text-sm gap-above-3', text: txn.description })
              : null,
          ]),
        ]),
      ]);
    } catch (error) {
      const missing = error instanceof ApiError && error.status === 404;
      render(main, [
        stateBlock({
          variant: 'error',
          title: missing ? 'Transaction not found' : 'Could not load this transaction',
          message: missing
            ? 'It may have been deleted, or you may not have permission to see it.'
            : error instanceof ApiError
              ? `${error.message}${error.requestId ? ` (reference ${error.requestId})` : ''}`
              : 'Something went wrong.',
          action: el('a', { class: 'btn btn-outline-secondary', href: '/finance', text: 'Back' }),
        }),
      ]);
    }
  }
}
