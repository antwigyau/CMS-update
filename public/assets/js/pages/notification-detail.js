/**
 * Announcement detail — review and retract.
 *
 * A publisher opens a published announcement to see what was sent, to whom, and
 * how many inboxes it reached. Retracting deletes the notification and cascades
 * its delivery rows, so it disappears from every inbox at once — a two-step
 * confirm guards the click. The API and RLS gate the delete regardless of what
 * this page renders.
 */

import { ApiError, api } from '../core/api.js';
import { el, icon, render, skeletonLines, stateBlock } from '../core/dom.js';
import { formatCount, formatDateTime, humanise } from '../core/format.js';
import { can, churchName, requireSession, signOut } from '../core/session.js';
import { renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';

/** severity -> pill colour, matching the inbox and list. */
const SEVERITY_VARIANT = Object.freeze({
  info: 'neutral',
  warning: 'warning',
  critical: 'danger',
});

const notificationId = new URLSearchParams(location.search).get('id');

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/admin/notifications',
    title: 'Announcement',
    user: session.user,
    can,
    onSignOut: signOut,
    churchName: churchName(),
  });

  let notification = null;
  const dangerRegion = el('div');

  function definition(term, value) {
    return [
      el('dt', { class: 'detail-list__term', text: term }),
      el('dd', { class: 'detail-list__value', text: value ?? '—' }),
    ];
  }

  /* ---- retract ---------------------------------------------------------- */

  function renderDeletePrompt() {
    const button = el('button', {
      class: 'btn btn-outline-danger',
      type: 'button',
      text: 'Retract announcement',
    });
    button.addEventListener('click', renderDeleteConfirm);
    render(dangerRegion, [
      button,
      el('p', {
        class: 'field__hint',
        text: 'Retracting removes it from every inbox. This cannot be undone.',
      }),
    ]);
  }

  function renderDeleteConfirm() {
    const confirmButton = el('button', {
      class: 'btn btn-danger',
      type: 'button',
      text: 'Yes, retract',
    });
    const cancelButton = el('button', {
      class: 'btn btn-outline-secondary',
      type: 'button',
      text: 'Cancel',
    });
    confirmButton.addEventListener('click', () => deleteNotification(confirmButton, cancelButton));
    cancelButton.addEventListener('click', renderDeletePrompt);
    render(dangerRegion, [
      el('p', {
        class: 'text-sm',
        text: 'Retract this announcement for good? It will vanish from every inbox.',
      }),
      el('div', { class: 'cluster' }, [confirmButton, cancelButton]),
    ]);
  }

  async function deleteNotification(confirmButton, cancelButton) {
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    try {
      await api.delete(`/admin/notifications/${encodeURIComponent(notificationId)}`);
      notify.success('Announcement retracted.');
      location.assign('/admin/notifications');
    } catch (error) {
      notify.error(
        error instanceof ApiError ? error.message : 'Could not retract this announcement.',
      );
      renderDeletePrompt();
    }
  }

  /* ---- page ------------------------------------------------------------- */

  function renderPage() {
    renderDeletePrompt();

    render(main, [
      el('div', { class: 'page-header' }, [
        el('div', {}, [
          el('h1', { class: 'page-header__title', text: notification.title }),
          el('p', { class: 'page-header__subtitle' }, [
            el('span', { class: 'pill pill--neutral', text: humanise(notification.type) }),
            ' · ',
            el('span', {
              class: `pill pill--${SEVERITY_VARIANT[notification.severity] ?? 'neutral'}`,
              text: humanise(notification.severity),
            }),
          ]),
        ]),
        el('div', { class: 'page-header__actions' }, [
          el('a', {
            class: 'btn btn-outline-secondary',
            href: '/admin/notifications',
            text: 'All announcements',
          }),
        ]),
      ]),
      el('section', { class: 'card-surface gap-below-5' }, [
        el('div', { class: 'card-surface__header' }, [
          el('h2', { class: 'card-surface__title' }, [icon('card-text'), ' Message']),
        ]),
        el('div', { class: 'card-surface__body' }, [
          el('p', { class: 'notif-detail__body', text: notification.body }),
        ]),
      ]),
      el('section', { class: 'card-surface gap-below-5' }, [
        el('div', { class: 'card-surface__header' }, [
          el('h2', { class: 'card-surface__title' }, [icon('info-circle'), ' Details']),
        ]),
        el('div', { class: 'card-surface__body' }, [
          el(
            'dl',
            { class: 'detail-list' },
            [
              definition('Audience', humanise(notification.audience)),
              definition('Recipients', formatCount(notification.recipientCount, 'recipient')),
              definition('Published', formatDateTime(notification.publishedAt)),
              definition(
                'Expires',
                notification.expiresAt ? formatDateTime(notification.expiresAt) : 'No expiry',
              ),
              definition('Link', notification.linkPath),
            ].flat(),
          ),
        ]),
      ]),
      el('section', { class: 'card-surface' }, [
        el('div', { class: 'card-surface__header' }, [
          el('h2', { class: 'card-surface__title' }, [
            icon('exclamation-triangle'),
            ' Danger zone',
          ]),
        ]),
        el('div', { class: 'card-surface__body' }, [dangerRegion]),
      ]),
    ]);
  }

  /* ---- loading ---------------------------------------------------------- */

  async function load() {
    render(main, [
      el('section', { class: 'card-surface' }, [
        el('div', { class: 'card-surface__body' }, [skeletonLines(6)]),
      ]),
    ]);

    try {
      const payload = await api.get(`/admin/notifications/${encodeURIComponent(notificationId)}`);
      notification = payload.data;
      renderPage();
    } catch (error) {
      const notFound = error instanceof ApiError && error.status === 404;
      render(main, [
        stateBlock({
          variant: 'error',
          title: notFound ? 'Announcement not found' : 'Could not load this announcement',
          message: notFound
            ? 'It may have been retracted, or you may not have permission to see it.'
            : 'The request failed. Try again in a moment.',
          action: el('a', {
            class: 'btn btn-outline-secondary',
            href: '/admin/notifications',
            text: 'Back to announcements',
          }),
        }),
      ]);
    }
  }

  if (!notificationId) {
    render(main, [
      stateBlock({
        variant: 'error',
        title: 'No announcement selected',
        message: 'This page needs an announcement id.',
        action: el('a', {
          class: 'btn btn-outline-secondary',
          href: '/admin/notifications',
          text: 'Back to announcements',
        }),
      }),
    ]);
  } else {
    await load();
  }
}
