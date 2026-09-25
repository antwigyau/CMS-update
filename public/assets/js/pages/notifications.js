/**
 * Notifications — the reader's inbox.
 *
 * Every signed-in user with `notifications.view` sees the announcements
 * addressed to them here. The list is one request; there is no pagination
 * because an inbox is naturally bounded and expired items drop out of the query
 * server-side. Marking read is best-effort chrome — RLS scopes every
 * read-marking to the caller regardless of what this page does.
 */

import { ApiError, api } from '../core/api.js';
import { el, render, skeletonLines, stateBlock } from '../core/dom.js';
import { formatDateTime, humanise } from '../core/format.js';
import { can, churchName, requireSession, signOut } from '../core/session.js';
import { refreshNotificationBadge, renderShell } from '../core/shell.js';
import { notify } from '../core/toast.js';

/** severity -> pill colour. */
const SEVERITY_VARIANT = Object.freeze({
  info: 'neutral',
  warning: 'warning',
  critical: 'danger',
});

const session = await requireSession();

if (session) {
  const { main } = renderShell({
    mount: document.getElementById('app'),
    active: '/notifications',
    title: 'Notifications',
    user: session.user,
    can,
    onSignOut: signOut,
    churchName: churchName(),
  });

  // The inbox as last fetched, so a click can flip one item's read state
  // without another round trip.
  let items = [];

  const listRegion = el('div', { id: 'inbox-results' });
  const markAllButton = el('button', {
    class: 'btn btn-outline-secondary',
    type: 'button',
    text: 'Mark all read',
    onclick: () => markAllRead(),
  });

  /* ---- one item --------------------------------------------------------- */

  function item(notification) {
    const unread = !notification.read;
    return el(
      'button',
      {
        class: `notif-item${unread ? ' notif-item--unread' : ''}`,
        type: 'button',
        onclick: () => openItem(notification),
      },
      [
        unread ? el('span', { class: 'notif-item__dot', 'aria-hidden': 'true' }) : null,
        el('span', { class: 'notif-item__body' }, [
          el('span', { class: 'cluster' }, [
            el('span', {
              class: `pill pill--${SEVERITY_VARIANT[notification.severity] ?? 'neutral'}`,
              text: humanise(notification.severity),
            }),
            notification.linkPath
              ? el('span', { class: 'text-xs text-muted-token', text: 'Opens a link' })
              : null,
          ]),
          el('span', { class: 'notif-item__title', text: notification.title }),
          el('span', { class: 'notif-item__message', text: notification.body }),
          el('span', {
            class: 'notif-item__meta',
            text: formatDateTime(notification.publishedAt),
          }),
        ]),
      ],
    );
  }

  function renderList() {
    // "Mark all read" is only meaningful while something is still unread.
    markAllButton.disabled = !items.some((n) => !n.read);
    render(listRegion, [
      items.length === 0
        ? stateBlock({
            iconName: 'bell',
            title: 'No notifications',
            message: 'Announcements addressed to you will appear here.',
          })
        : el('div', { class: 'notif-list' }, items.map(item)),
    ]);
  }

  /* ---- interactions ----------------------------------------------------- */

  async function openItem(notification) {
    const wasUnread = !notification.read;
    if (wasUnread) {
      notification.read = true;
      renderList();
    }

    // With a link, make sure the read-marking lands before navigating away;
    // without one, the click only marks read, so it need not block.
    if (notification.linkPath) {
      if (wasUnread) await markRead(notification.id);
      location.assign(notification.linkPath);
      return;
    }
    if (wasUnread) {
      await markRead(notification.id);
      refreshNotificationBadge();
    }
  }

  async function markRead(id) {
    try {
      await api.post(`/notifications/${encodeURIComponent(id)}/read`);
    } catch {
      // Best-effort: the true read state resyncs on the next load.
    }
  }

  async function markAllRead() {
    markAllButton.disabled = true;
    try {
      await api.post('/notifications/read-all');
      for (const n of items) n.read = true;
      renderList();
      refreshNotificationBadge();
    } catch (error) {
      notify.error(error instanceof ApiError ? error.message : 'Could not mark all as read.');
      renderList();
    }
  }

  /* ---- loading ---------------------------------------------------------- */

  async function load() {
    render(listRegion, [skeletonLines(5)]);
    listRegion.setAttribute('aria-busy', 'true');
    try {
      const payload = await api.get('/notifications');
      items = payload.data;
      renderList();
    } catch (error) {
      render(listRegion, [
        stateBlock({
          variant: 'error',
          title: 'Could not load notifications',
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
      listRegion.removeAttribute('aria-busy');
    }
  }

  render(main, [
    el('div', { class: 'page-header' }, [
      el('div', {}, [
        el('h1', { class: 'page-header__title', text: 'Notifications' }),
        el('p', {
          class: 'page-header__subtitle',
          text: 'Announcements and alerts addressed to you.',
        }),
      ]),
      el('div', { class: 'page-header__actions' }, [markAllButton]),
    ]),
    listRegion,
  ]);

  await load();
}
